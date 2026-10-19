import {
  AGENT_PROTOCOL,
  parseAgentResponse,
  type AgentCompletion,
  type AgentRequest,
  type AgentResource,
  type HttpRequestTemplate,
  type InlineArtifact,
  type ReferenceArtifact,
} from '@attest/contracts';

import { AgentInvocationError, abortedError } from '../../errors.js';
import type { AgentResponseCandidate } from '../../internal/agent-response-candidate.js';
import {
  DEFAULT_ARTIFACT_BYTES,
  DEFAULT_ATTEMPT_MS,
  DEFAULT_CONNECT_MS,
  DEFAULT_FIRST_BYTE_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_REQUEST_BYTES,
  DEFAULT_RESPONSE_BYTES,
  DEFAULT_TOTAL_ARTIFACT_BYTES,
} from '../../internal/agent-defaults.js';
import {
  artifactByteLength,
  assertArtifactManifest,
  assertArtifactSizes,
} from '../../internal/artifact-limits.js';
import { startTimer } from '../../internal/elapsed.js';
import { parseJson } from '../../internal/json-value.js';
import { createRawExcerpt } from '../../internal/raw-excerpt.js';
import { retryBackoffDelay } from '../../internal/retry-backoff.js';
import type { InvocationAttempt, InvocationDiagnostics, InvocationResult } from '../../types.js';
import {
  requestHttp,
  type HttpClientPolicy,
  type HttpJsonTransport,
  type HttpResponse,
} from '../http/http-client.js';
import {
  attemptFromError,
  normalizeFailure,
  requestWithRetries,
  setIdempotencyHeader,
} from '../http/mapped-http-execution.js';
import { redactTransportText } from '../http/redaction.js';
import {
  assertStaticUrlAuthority,
  materializeHttpRequest,
  materializeStaticRequest,
  resolveRequestTemplate,
  type RequestTemplateOverrides,
  type ResolvedHttpRequestTemplate,
} from '../http/request-template.js';
import { parseRetryAfter } from '../http/retry-after.js';
import type { CompletionReceiver, CompletionRegistration } from './completion-receiver.js';

/** An async agent that is triggered over HTTP and posts its completion back to attest. */
type CallbackAgentResource = AgentResource & {
  transport: Extract<AgentResource['transport'], { kind: 'callback' }>;
};

/** Cancellation shared by both halves; `deadlineSignal` aborts are recorded as `timeout`. */
type CallbackSignals = {
  /** Values to hide in evidence; the trigger also hides the registration token. */
  secrets?: readonly string[];
  /** The caller's cancellation; its abort is recorded as `cancelled`. */
  signal?: AbortSignal;
  /** A deadline owned by an enclosing invocation. */
  deadlineSignal?: AbortSignal;
};

type TriggerCallbackOptions = CallbackSignals &
  RequestTemplateOverrides & {
    registration: Pick<CompletionRegistration, 'url' | 'token'>;
  };

type CompleteCallbackOptions = CallbackSignals & {
  /** Runtime-resolved header and query values for `artifact_fetch`. */
  artifactFetch?: RequestTemplateOverrides;
  /** Runtime-resolved header and query values for `trace_fetch`. */
  traceFetch?: RequestTemplateOverrides;
};

type InvokeCallbackOptions = Omit<CompleteCallbackOptions, 'deadlineSignal'> & {
  receiver: CompletionReceiver;
  /** Runtime-resolved header and query values for `trigger`. */
  trigger?: RequestTemplateOverrides;
};

/**
 * What sending the trigger produced. `triggered` carries the trigger's diagnostics and any failed
 * tries that were retried; a failure is already a complete invocation result.
 */
type CallbackTriggerResult =
  | {
      status: 'triggered';
      attempts: InvocationAttempt[];
      diagnostics: InvocationDiagnostics;
      durationMs: number;
    }
  | InvocationResult;

/** Classifies an unexpected throw under this adapter's name. */
const callbackFailure = (
  cause: unknown,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): AgentInvocationError =>
  normalizeFailure(cause, { transport: 'Callback agent', signal, callerSignal });

/** Combines the attempt deadline with the caller's and the enclosing invocation's signals. */
const attemptSignal = (agent: CallbackAgentResource, options: CallbackSignals): AbortSignal =>
  AbortSignal.any(
    [
      AbortSignal.timeout(agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS),
      options.signal,
      options.deadlineSignal,
    ].filter((candidate) => candidate !== undefined),
  );

const clientPolicy = (
  agent: CallbackAgentResource,
  signal: AbortSignal,
  options: CallbackSignals & { responseCapBytes: number },
): HttpClientPolicy => ({
  attemptSignal: signal,
  callerSignal: options.signal,
  connectTimeoutMs: agent.timeouts?.connect_ms ?? DEFAULT_CONNECT_MS,
  firstByteTimeoutMs: agent.timeouts?.first_byte_ms ?? DEFAULT_FIRST_BYTE_MS,
  responseBodyTimeoutMs: agent.timeouts?.idle_ms ?? DEFAULT_IDLE_MS,
  responseCapBytes: options.responseCapBytes,
  secrets: options.secrets ?? [],
});

/** The trigger only has to be accepted; its body is kept as evidence and never parsed. */
const discardBody: HttpJsonTransport = async (request, policy) => {
  const response = await requestHttp(request, policy);

  return {
    headers: response.headers,
    raw: null,
    rawExcerpt: response.rawExcerpt,
    status: response.status,
    url: response.url,
  };
};

/**
 * Sends the trigger: the request envelope plus `callback` as the body of the authored request.
 * Any 2xx means the agent accepted the work. Retryable failures are replayed only when the agent
 * names an idempotency header, because a replayed trigger can start the work twice.
 */
const triggerCallbackAgent = async (
  agent: CallbackAgentResource,
  request: AgentRequest,
  options: TriggerCallbackOptions,
): Promise<CallbackTriggerResult> => {
  const duration = startTimer();
  const signal = attemptSignal(agent, options);
  const { url, token } = options.registration;
  const secrets = [...(options.secrets ?? []), token];
  const retryAttempts: InvocationAttempt[] = [];
  const { transport } = agent;

  try {
    if (signal.aborted) throw abortedError(options.signal, 'Callback agent trigger');

    // `{{request}}` maps the whole envelope, so the request cap also covers the body.
    const template: HttpRequestTemplate = {
      ...transport.trigger,
      body: '{{request}}',
      body_encoding: 'json',
    };

    const materialized = materializeHttpRequest(
      resolveRequestTemplate(template, options),
      { ...request, callback: { url, token } },
      agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
    );

    if (transport.idempotency_header !== undefined) {
      setIdempotencyHeader(materialized.headers, transport.idempotency_header, request);
    }

    const policy = clientPolicy(agent, signal, {
      ...options,
      secrets,
      responseCapBytes: agent.limits?.response_bytes ?? DEFAULT_RESPONSE_BYTES,
    });

    const sent = await requestWithRetries(
      materialized,
      { retry: agent.retry, policy, signal, retryAttempts, requestJson: discardBody },
      {
        allowRetry: transport.idempotency_header !== undefined,
        delayFor: (retry, retryAfter) =>
          parseRetryAfter(retryAfter) ?? retryBackoffDelay(agent.retry?.backoff, retry),
      },
    );

    if (!sent.ok) {
      const attempt = attemptFromError(sent.error, sent.durationMs);

      return { ...attempt, attempts: [...retryAttempts, attempt] };
    }

    return {
      status: 'triggered',
      attempts: retryAttempts,
      diagnostics: { httpStatus: sent.response.status },
      durationMs: duration(),
    };
  } catch (error: unknown) {
    const attempt = attemptFromError(callbackFailure(error, signal, options.signal), duration());

    return { ...attempt, attempts: [...retryAttempts, attempt] };
  }
};

/**
 * Substitutes one fetch placeholder. The URL value is percent-encoded and may only appear in the
 * path or query, so an id cannot change which host is contacted.
 */
const fillPlaceholder = (
  template: ResolvedHttpRequestTemplate,
  placeholder: '{{artifact_id}}' | '{{trace_ref}}',
  value: string,
): ResolvedHttpRequestTemplate => {
  assertStaticUrlAuthority(template.url);

  const fill = (values: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(values ?? {}).map(([name, text]) => [
        name,
        text.replaceAll(placeholder, value),
      ]),
    );

  return {
    ...template,
    url: template.url.replaceAll(placeholder, encodeURIComponent(value)),
    headers: fill(template.headers),
    query: fill(template.query),
  };
};

type ReferenceFetch = {
  template: HttpRequestTemplate | undefined;
  overrides: RequestTemplateOverrides | undefined;
  placeholder: '{{artifact_id}}' | '{{trace_ref}}';
  value: string;
  policy: HttpClientPolicy;
  /** Names the authored field in errors, such as `artifact_fetch`. */
  field: 'artifact_fetch' | 'trace_fetch';
};

/** GETs one referenced artifact or trace through the same egress rules as every HTTP agent. */
const fetchReference = async (agent: CallbackAgentResource, reference: ReferenceFetch) => {
  if (reference.template === undefined) {
    throw new AgentInvocationError(
      'invalid_envelope',
      `The completion holds a reference, but the agent defines no ${reference.field} template.`,
    );
  }

  const materialized = materializeStaticRequest(
    fillPlaceholder(
      resolveRequestTemplate(reference.template, reference.overrides ?? {}),
      reference.placeholder,
      reference.value,
    ),
    agent.limits?.request_bytes ?? DEFAULT_REQUEST_BYTES,
  );

  const response: HttpResponse = await requestHttp(materialized, reference.policy);

  if (response.status < 200 || response.status >= 300) {
    throw new AgentInvocationError(
      'http_status',
      `Callback ${reference.field} returned status ${response.status}.`,
      { httpStatus: response.status, rawExcerpt: response.rawExcerpt },
    );
  }

  return response;
};

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Keeps fetched bytes as text when they are valid UTF-8, else as base64. */
const encodeArtifactBytes = (bytes: Buffer): Pick<InlineArtifact, 'encoding' | 'content'> => {
  try {
    return { encoding: 'utf8', content: UTF8.decode(bytes) };
  } catch {
    return { encoding: 'base64', content: bytes.toString('base64') };
  }
};

const resolveArtifact = async (
  agent: CallbackAgentResource,
  artifact: ReferenceArtifact,
  fetch: Pick<ReferenceFetch, 'overrides' | 'policy'>,
): Promise<InlineArtifact> => {
  const response = await fetchReference(agent, {
    ...fetch,
    template: agent.transport.artifact_fetch,
    placeholder: '{{artifact_id}}',
    value: artifact.id,
    field: 'artifact_fetch',
  });

  const contentType = response.headers['content-type']?.split(';')[0]?.trim();

  return {
    kind: 'inline',
    path: artifact.path,
    media_type:
      artifact.media_type ??
      (contentType === undefined || contentType === '' ? 'application/octet-stream' : contentType),
    ...encodeArtifactBytes(response.body),
  };
};

const resolveTrace = async (
  agent: CallbackAgentResource,
  traceRef: string,
  fetch: Pick<ReferenceFetch, 'overrides' | 'policy'>,
) => {
  const response = await fetchReference(agent, {
    ...fetch,
    template: agent.transport.trace_fetch,
    placeholder: '{{trace_ref}}',
    value: traceRef,
    field: 'trace_fetch',
  });

  try {
    return parseJson(response.body.toString('utf8'));
  } catch (error: unknown) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'Callback trace_fetch did not return JSON.',
      {
        cause: error,
        rawExcerpt: response.rawExcerpt,
      },
    );
  }
};

/**
 * Turns a completion into one attempt holding an ordinary response envelope: reference artifacts
 * and `trace_ref` are fetched, the artifact caps are enforced, and the envelope is parsed.
 */
const completeCallbackAgent = async (
  agent: CallbackAgentResource,
  completion: AgentCompletion,
  options: CompleteCallbackOptions = {},
): Promise<InvocationAttempt> => {
  const duration = startTimer();
  const signal = attemptSignal(agent, options);
  const secrets = options.secrets ?? [];
  const rawExcerpt = createRawExcerpt(redactTransportText(JSON.stringify(completion), secrets));

  try {
    if (signal.aborted) throw abortedError(options.signal, 'Callback agent completion');
    const artifacts = completion.artifacts ?? [];
    // Count and path checks first, so an over-limit completion triggers no fetches.
    assertArtifactManifest(artifacts, agent.limits);

    const perArtifact = agent.limits?.artifact_bytes ?? DEFAULT_ARTIFACT_BYTES;
    let remaining = agent.limits?.total_artifact_bytes ?? DEFAULT_TOTAL_ARTIFACT_BYTES;
    const resolved: InlineArtifact[] = [];

    for (const artifact of artifacts) {
      // Once the total is spent, the size check below reports it without fetching more.
      if (remaining < 0) break;

      // A fetch may only read what is left of the total, so references never buffer past it.
      const inline =
        artifact.kind === 'inline'
          ? artifact
          : await resolveArtifact(agent, artifact, {
              overrides: options.artifactFetch,
              policy: clientPolicy(agent, signal, {
                ...options,
                responseCapBytes: Math.min(perArtifact, remaining),
              }),
            });

      remaining -= artifactByteLength(inline);
      resolved.push(inline);
    }

    assertArtifactSizes(resolved, agent.limits);

    const trace =
      completion.trace_ref === undefined
        ? completion.trace
        : await resolveTrace(agent, completion.trace_ref, {
            overrides: options.traceFetch,
            policy: clientPolicy(agent, signal, {
              ...options,
              responseCapBytes: agent.limits?.response_bytes ?? DEFAULT_RESPONSE_BYTES,
            }),
          });

    const envelope: AgentResponseCandidate =
      'error' in completion
        ? { protocol: AGENT_PROTOCOL, error: completion.error }
        : { protocol: AGENT_PROTOCOL, output: completion.output };

    if (completion.state !== undefined) envelope.state = completion.state;

    if (trace !== undefined) envelope.trace = trace;

    if (resolved.length > 0) envelope.artifacts = resolved;
    const report = parseAgentResponse(envelope);

    if (!report.ok) {
      throw new AgentInvocationError(
        'invalid_envelope',
        'Callback completion is not a valid agent response.',
        { rawExcerpt },
      );
    }

    return {
      status: 'ok',
      raw: envelope,
      report,
      diagnostics: {},
      durationMs: duration(),
      rawExcerpt,
      warnings: report.warnings,
    };
  } catch (error: unknown) {
    return attemptFromError(callbackFailure(error, signal, options.signal), duration());
  }
};

/** Waits for the posted completion, classifying an abort as `timeout` or `cancelled`. */
const awaitCompletion = async (
  registration: CompletionRegistration,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): Promise<AgentCompletion> => {
  try {
    return await registration.completion;
  } catch (cause: unknown) {
    if (signal.aborted) throw abortedError(callerSignal, 'Callback agent completion', { cause });
    throw new AgentInvocationError(
      'network',
      'The completion receiver stopped before the agent posted its completion.',
      { cause },
    );
  }
};

/**
 * Runs one callback invocation in-process: register a callback URL, send the trigger, wait for the
 * completion under `timeouts.attempt_ms`, then resolve it. The registration is always released.
 */
const invokeCallbackAgent = async (
  agent: CallbackAgentResource,
  request: AgentRequest,
  options: InvokeCallbackOptions,
): Promise<InvocationResult> => {
  const duration = startTimer();
  const deadline = AbortSignal.timeout(agent.timeouts?.attempt_ms ?? DEFAULT_ATTEMPT_MS);

  const signal = AbortSignal.any(
    [deadline, options.signal].filter((candidate) => candidate !== undefined),
  );

  const shared = { secrets: options.secrets, signal: options.signal, deadlineSignal: deadline };
  let registration: CompletionRegistration | undefined;
  let earlierAttempts: InvocationAttempt[] = [];
  let diagnostics: InvocationDiagnostics = {};

  try {
    registration = await options.receiver.register({
      runId: request.run_id,
      caseId: request.case_id,
      signal,
    });

    const triggered = await triggerCallbackAgent(agent, request, {
      ...options.trigger,
      ...shared,
      registration,
    });

    if (triggered.status !== 'triggered') return triggered;
    earlierAttempts = triggered.attempts;
    diagnostics = triggered.diagnostics;

    const completion = await awaitCompletion(registration, signal, options.signal);

    const completed = await completeCallbackAgent(agent, completion, {
      ...shared,
      artifactFetch: options.artifactFetch,
      traceFetch: options.traceFetch,
    });

    const attempt: InvocationAttempt = {
      ...completed,
      diagnostics: { ...completed.diagnostics, ...diagnostics },
      durationMs: duration(),
    };

    return { ...attempt, attempts: [...earlierAttempts, attempt] };
  } catch (error: unknown) {
    const failed = attemptFromError(callbackFailure(error, signal, options.signal), duration());
    const attempt: InvocationAttempt = { ...failed, diagnostics };

    return { ...attempt, attempts: [...earlierAttempts, attempt] };
  } finally {
    registration?.release();
  }
};

export {
  completeCallbackAgent,
  invokeCallbackAgent,
  triggerCallbackAgent,
  type CallbackAgentResource,
};
