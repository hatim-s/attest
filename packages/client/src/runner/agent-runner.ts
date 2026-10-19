import {
  AGENT_COMPLETION_PROTOCOL,
  agentCompletionSchema,
  parseAgentRequest,
  type AgentCallback,
  type AgentErrorResponse,
  type AgentRequest,
  type Artifact,
  type JsonValue,
  type Trace,
} from '@attest/contracts';

import { deliverCompletion } from './deliver-completion.js';
import { readBoundedText } from './read-bounded-text.js';
import { tokensMatch } from './tokens-match.js';

// Matches the executor's default request_bytes limit, the largest envelope attest sends.
const REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/** A validated trigger. The runner only accepts requests that say where to post the result. */
type AgentInvocation = AgentRequest & { callback: AgentCallback };

type AgentError = AgentErrorResponse['error'];

type HandlerOutcome = { output: JsonValue } | { error: AgentError };

/** What a handler returns; the runner adds the protocol, run and case ids. */
type HandlerResult = HandlerOutcome & {
  artifacts?: Artifact[];
  trace?: Trace;
  trace_ref?: string;
  state?: JsonValue;
};

type HandlerContext = {
  /** Aborts when the runner closes. Attest has no remote cancellation in v1. */
  signal: AbortSignal;
};

type AgentHandler = (
  invocation: AgentInvocation,
  context: HandlerContext,
) => Promise<HandlerResult>;

/** A background failure the trigger response could not report, because it was already sent. */
type RunnerFailure = {
  kind: 'handler_failed' | 'invalid_completion' | 'delivery_failed';
  runId: string;
  caseId: string;
  message: string;
};

type AgentRunnerOptions = {
  handler: AgentHandler;
  /** Posts completions. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Receives background failures. Defaults to one line on stderr. */
  onError?: (failure: RunnerFailure) => void;
  /** The only path that accepts triggers. Defaults to `/`. */
  path?: string;
  /**
   * When set, a trigger must carry `Authorization: Bearer <triggerToken>`. Set it whenever the
   * runner is reachable by anything other than attest: a trigger makes the handler run a prompt.
   */
  triggerToken?: string;
};

type AgentRunner = {
  /** Web-standard handler: plug it into `Bun.serve`, a Worker or `serveAgentRunner`. */
  fetch: (request: Request) => Promise<Response>;
  /** Invocations accepted but not yet delivered. */
  pending: () => number;
  /** Resolves once every accepted invocation has posted its completion or given up. */
  drain: () => Promise<void>;
  /** Refuses new triggers with 503, aborts running handlers, then drains. */
  close: () => Promise<void>;
};

const reportToStderr = (failure: RunnerFailure): void => {
  console.error(
    `[attest-client] ${failure.kind} run=${failure.runId} case=${failure.caseId}: ${failure.message}`,
  );
};

/** Parses the trigger body, or returns `undefined` when it is not JSON at all. */
const parseTrigger = (text: string): ReturnType<typeof parseAgentRequest> | undefined => {
  try {
    return parseAgentRequest(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * Creates a runner that accepts `attest.agent-invocation` triggers carrying a `callback`, answers
 * 202 at once, runs the handler in the background and posts an `attest.agent-completion` to the
 * callback URL. A handler throw becomes an error completion with code `handler_failed`; a result
 * that fails the completion schema becomes one with code `invalid_completion`, so attest always
 * hears back instead of waiting for its attempt timeout.
 */
const createAgentRunner = ({
  handler,
  fetch: fetchImpl = globalThis.fetch,
  onError = reportToStderr,
  path = '/',
  triggerToken,
}: AgentRunnerOptions): AgentRunner => {
  const inFlight = new Map<string, Promise<void>>();
  const closing = new AbortController();

  const settleHandler = async (invocation: AgentInvocation): Promise<HandlerResult> => {
    try {
      return await handler(invocation, { signal: closing.signal });
    } catch (error) {
      if (closing.signal.aborted) {
        return {
          error: { code: 'cancelled', message: 'The runner closed before the handler finished.' },
        };
      }

      const message = error instanceof Error ? error.message : String(error);

      onError({
        kind: 'handler_failed',
        runId: invocation.run_id,
        caseId: invocation.case_id,
        message,
      });

      return { error: { code: 'handler_failed', message } };
    }
  };

  /** Serializes the completion, replacing a result the receiver would reject with an error. */
  const serializeCompletion = (invocation: AgentInvocation, result: HandlerResult): string => {
    const ids = {
      protocol: AGENT_COMPLETION_PROTOCOL,
      run_id: invocation.run_id,
      case_id: invocation.case_id,
    };

    const checked = agentCompletionSchema.safeParse({ ...ids, ...result });

    if (checked.success) return JSON.stringify(checked.data);

    const message = checked.error.issues
      .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
      .join('; ');

    onError({ kind: 'invalid_completion', runId: ids.run_id, caseId: ids.case_id, message });

    return JSON.stringify({ ...ids, error: { code: 'invalid_completion', message } });
  };

  const run = async (invocation: AgentInvocation): Promise<void> => {
    const body = serializeCompletion(invocation, await settleHandler(invocation));
    const outcome = await deliverCompletion(fetchImpl, invocation.callback, body);

    if (!outcome.delivered) {
      onError({
        kind: 'delivery_failed',
        runId: invocation.run_id,
        caseId: invocation.case_id,
        message: outcome.reason,
      });
    }
  };

  /** Starts the invocation unless the same run and case is already running (a retried trigger). */
  const accept = (invocation: AgentInvocation): Response => {
    const key = `${invocation.run_id}/${invocation.case_id}`;

    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        run(invocation).finally(() => inFlight.delete(key)),
      );
    }

    return Response.json(
      { accepted: true, run_id: invocation.run_id, case_id: invocation.case_id },
      { status: 202 },
    );
  };

  const drain = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all(inFlight.values());
  };

  return {
    fetch: async (request) => {
      if (new URL(request.url).pathname !== path) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }

      if (request.method !== 'POST') {
        return Response.json(
          { error: 'method_not_allowed' },
          { status: 405, headers: { allow: 'POST' } },
        );
      }

      if (closing.signal.aborted) return Response.json({ error: 'closing' }, { status: 503 });

      if (
        triggerToken !== undefined &&
        !tokensMatch(request.headers.get('authorization') ?? '', `Bearer ${triggerToken}`)
      ) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      // Requiring JSON forces a CORS preflight, so a web page cannot trigger a local runner.
      if (!/^application\/json\s*(?:;|$)/iu.test(request.headers.get('content-type') ?? '')) {
        return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
      }

      const text = await readBoundedText(request, REQUEST_BODY_LIMIT_BYTES);

      if (text === undefined) return Response.json({ error: 'too_large' }, { status: 413 });
      const parsed = parseTrigger(text);

      if (parsed === undefined) return Response.json({ error: 'invalid_json' }, { status: 400 });

      if (!parsed.ok) {
        return Response.json({ error: 'invalid_request', issues: parsed.error }, { status: 400 });
      }

      const { callback } = parsed.value;

      if (callback === undefined) {
        return Response.json({ error: 'missing_callback' }, { status: 400 });
      }

      return accept({ ...parsed.value, callback });
    },
    pending: () => inFlight.size,
    drain,
    close: async () => {
      closing.abort();
      await drain();
    },
  };
};

export {
  createAgentRunner,
  type AgentHandler,
  type AgentInvocation,
  type AgentRunner,
  type AgentRunnerOptions,
  type HandlerContext,
  type HandlerOutcome,
  type HandlerResult,
  type RunnerFailure,
};
