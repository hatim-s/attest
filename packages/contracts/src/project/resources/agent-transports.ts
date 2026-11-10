import { safeIntegerSchema } from '../../schema/scalars.js';
import { isString } from '../shared.js';
import * as Schema from 'effect/Schema';

import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  refinePollingSchedule,
  relativePathSchema,
  secretReferenceSchema,
} from '../shared.js';
import { reportDuplicates } from '../../internal/duplicates.js';
import { webSocketTransportSchema } from '../../agent/websocket-contract.js';

const httpUrlTemplateSchema = Schema.String.check(
  Schema.isPattern(/^https?:\/\/\S+$/u, { message: 'must be an HTTP or HTTPS URL template' }),
);

const templateValueSchema = Schema.Union([Schema.String, secretReferenceSchema]);

/** Builds a foreign HTTP request before normalization at the runner boundary. */
const httpRequestTemplateSchema = Schema.Struct({
  url: httpUrlTemplateSchema,
  method: Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  headers: Schema.optional(Schema.Record(Schema.String, templateValueSchema)),
  query: Schema.optional(Schema.Record(Schema.String, templateValueSchema)),
  body: Schema.optional(Schema.Json),
  body_encoding: Schema.optional(Schema.Literals(['json', 'raw'])),
})
  .check(
    Schema.makeFilter((request) => {
      const context: Schema.FilterIssue[] = [];

      if (request.body_encoding === 'raw' && !isString(request.body)) {
        context.push({
          path: ['body'],
          issue: 'must be a string when body_encoding is raw',
        });
      }

      if (request.body === undefined && request.body_encoding !== undefined) {
        context.push({
          path: ['body_encoding'],
          issue: 'requires a body',
        });
      }

      return context;
    }),
  )
  .annotate({ identifier: 'HttpRequestTemplate' });

/** Extracts a normalized agent outcome from a foreign response or terminal event. */
const responseExtractionSchema = Schema.Struct({
  result_pointer: jsonPointerSchema,
  error_pointer: Schema.optional(jsonPointerSchema),
  trace_pointer: Schema.optional(jsonPointerSchema),
  remote_job_id_pointer: Schema.optional(jsonPointerSchema),
}).annotate({ identifier: 'ResponseExtraction' });

/**
 * A process argv with at least an executable. The length check aborts on failure, so the
 * refinement only runs on a non-empty array; it gives the decoded value a non-empty tuple type
 * so spawners need no empty case and an empty argv reports one issue.
 */
const argvSchema = Schema.Array(Schema.String)
  .check(Schema.isMinLength(1).abort())
  .pipe(Schema.refine((argv): argv is readonly [string, ...string[]] => argv.length > 0));

const processEnvironmentSchema = Schema.Record(Schema.String, secretReferenceSchema);

const literalRelativePathSchema = relativePathSchema.check(
  Schema.isPattern(/^[^*?\[\]{}]+$/u, { message: 'must not contain glob metacharacters' }),
);

/** Uploads one project file into a Vercel sandbox before agent invocation. */
const vercelSandboxFileSchema = Schema.Struct({
  source: literalRelativePathSchema,
  destination: literalRelativePathSchema,
  mode: Schema.optional(
    safeIntegerSchema
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(0o777)),
  ),
});

/** Copies one sandbox artifact back into the project after agent invocation. */
const vercelSandboxArtifactSchema = Schema.Struct({
  source: literalRelativePathSchema,
  destination: literalRelativePathSchema,
});

/** Canonicalizes safe authored paths without consulting host-platform path rules. */
const canonicalRelativePath = (path: string): string =>
  path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');

/** Configures an isolated Vercel sandbox for one native CLI case. */
const vercelSandboxSchema = Schema.Struct({
  kind: Schema.Literal('vercel'),
  image: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  files: Schema.Array(vercelSandboxFileSchema),
  artifacts: Schema.optional(Schema.Array(vercelSandboxArtifactSchema)),
  artifact_directory: Schema.optional(relativePathSchema),
}).check(
  Schema.makeFilter((sandbox) => {
    const context: Schema.FilterIssue[] = []; // Aliased destinations would overwrite sandbox files or host artifacts.
    reportDuplicates({
      values: sandbox.files.map(({ destination }) => canonicalRelativePath(destination)),
      pathFor: (index) => ['files', index, 'destination'],
      label: 'file destination',
      context,
    });
    reportDuplicates({
      values: (sandbox.artifacts ?? []).map(({ destination }) =>
        canonicalRelativePath(destination),
      ),
      pathFor: (index) => ['artifacts', index, 'destination'],
      label: 'artifact destination',
      context,
    });

    return context;
  }),
);

const nativeForegroundTransportSchema = Schema.Struct({
  kind: Schema.Literal('native_cli'),
  lifecycle: Schema.Literal('per_case'),
  argv: argvSchema,
  cwd: Schema.optional(relativePathSchema),
  env: Schema.optional(processEnvironmentSchema),
  sandbox: Schema.optional(vercelSandboxSchema),
});

const backgroundReadinessSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('http'), url: httpUrlTemplateSchema }),
  Schema.Struct({
    kind: Schema.Literal('tcp'),
    host: Schema.String.check(Schema.isMinLength(1)),
    port: safeIntegerSchema
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(65_535)),
  }),
  Schema.Struct({
    kind: Schema.Literal('stderr'),
    pattern: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(512)),
  }),
]);

const nativeBackgroundTransportSchema = Schema.Struct({
  kind: Schema.Literal('background_cli'),
  lifecycle: Schema.Literal('per_run'),
  start_argv: argvSchema,
  cwd: Schema.optional(relativePathSchema),
  env: Schema.optional(processEnvironmentSchema),
  readiness: backgroundReadinessSchema,
  invoke: httpRequestTemplateSchema,
  extraction: responseExtractionSchema,
  shutdown: Schema.optional(httpRequestTemplateSchema),
  stop_timeout_ms: durationMillisecondsSchema,
});

const jsonlBridgeTransportSchema = Schema.Struct({
  kind: Schema.Literal('jsonl_bridge'),
  lifecycle: Schema.Literal('per_run'),
  argv: argvSchema,
  cwd: Schema.optional(relativePathSchema),
  env: Schema.optional(processEnvironmentSchema),
  concurrency: Schema.Literals(['serial', 'multiplexed']),
  cancellation_grace_ms: durationMillisecondsSchema,
});

const httpTransportSchema = Schema.Struct({
  kind: Schema.Literal('http'),
  lifecycle: Schema.Literal('external'),
  response_mode: Schema.Literals(['attest_envelope', 'mapped']),
  request: httpRequestTemplateSchema,
  extraction: responseExtractionSchema,
});

const pollingTransportSchema = Schema.Struct({
  kind: Schema.Literal('polling'),
  lifecycle: Schema.Literal('external'),
  submit: httpRequestTemplateSchema,
  idempotency_header: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  job_id_pointer: jsonPointerSchema,
  status_url_pointer: Schema.optional(jsonPointerSchema),
  status_url_template: Schema.optional(httpUrlTemplateSchema),
  status_pointer: jsonPointerSchema,
  success_values: Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  failure_values: Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  extraction: responseExtractionSchema,
  minimum_interval_ms: durationMillisecondsSchema,
  maximum_interval_ms: durationMillisecondsSchema,
}).check(
  Schema.makeFilter((value) => {
    const issues: Schema.FilterIssue[] = [];
    refinePollingSchedule(value, issues);

    return issues;
  }),
);

const streamIncrementalOutputModeSchema = Schema.Literals(['text', 'array']);

const streamTransportSchema = Schema.Struct({
  kind: Schema.Literal('stream'),
  lifecycle: Schema.Literal('external'),
  framing: Schema.Literals(['sse', 'jsonl']),
  request: httpRequestTemplateSchema,
  event_name: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  event_data_pointer: Schema.optional(jsonPointerSchema),
  terminal_pointer: jsonPointerSchema,
  terminal_values: Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  result_pointer: jsonPointerSchema,
  error_pointer: Schema.optional(jsonPointerSchema),
  trace_pointer: Schema.optional(jsonPointerSchema),
  incremental_output_pointer: Schema.optional(jsonPointerSchema),
  incremental_output_mode: Schema.optional(streamIncrementalOutputModeSchema),
  heartbeat_resets_application_idle: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((stream) => {
    const context: Schema.FilterIssue[] = [];

    if (
      (stream.incremental_output_pointer === undefined) !==
      (stream.incremental_output_mode === undefined)
    ) {
      context.push({
        path: ['incremental_output_mode'],
        issue: 'must be provided together with incremental_output_pointer',
      });
    }

    return context;
  }),
);

/**
 * Triggers an async agent and waits for it to post an `attest.agent-completion` back. Attest sends
 * the request envelope as the trigger body, and the fetch templates resolve reference artifacts
 * (`{{artifact_id}}`) and trace references (`{{trace_ref}}`).
 */
const callbackTransportSchema = Schema.Struct({
  kind: Schema.Literal('callback'),
  lifecycle: Schema.Literal('external'),
  trigger: httpRequestTemplateSchema,
  idempotency_header: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  artifact_fetch: Schema.optional(httpRequestTemplateSchema),
  trace_fetch: Schema.optional(httpRequestTemplateSchema),
  receiver: Schema.optional(
    Schema.Struct({
      // 0 binds an ephemeral port.
      listen_port: Schema.optional(
        safeIntegerSchema
          .check(Schema.isGreaterThanOrEqualTo(0))
          .check(Schema.isLessThanOrEqualTo(65_535)),
      ),
      // The base URL the agent is told to post to; defaults to the loopback listener.
      public_url: Schema.optional(httpUrlTemplateSchema),
    }),
  ),
}).check(
  Schema.makeFilter((callback) => {
    const context: Schema.FilterIssue[] = [];

    if (callback.trigger.method !== 'POST' && callback.trigger.method !== 'PUT') {
      context.push({
        path: ['trigger', 'method'],
        issue: 'must be POST or PUT',
      });
    }

    if (callback.trigger.body !== undefined) {
      context.push({
        path: ['trigger', 'body'],
        issue: 'must be omitted; attest sends the request envelope as the body',
      });
    }

    for (const field of ['artifact_fetch', 'trace_fetch'] as const) {
      if (callback[field] !== undefined && callback[field].method !== 'GET') {
        context.push({
          path: [field, 'method'],
          issue: 'must be GET',
        });
      }
    }

    return context;
  }),
);

/** Encodes every supported agent transport definition. */
const agentTransportSchema = Schema.Union([
  nativeForegroundTransportSchema,
  nativeBackgroundTransportSchema,
  jsonlBridgeTransportSchema,
  httpTransportSchema,
  pollingTransportSchema,
  streamTransportSchema,
  webSocketTransportSchema,
  callbackTransportSchema,
]);

type AgentTransport = typeof agentTransportSchema.Type;

type HttpRequestTemplate = typeof httpRequestTemplateSchema.Type;

type ResponseExtraction = typeof responseExtractionSchema.Type;

type VercelSandbox = typeof vercelSandboxSchema.Type;

type Argv = typeof argvSchema.Type;

export {
  agentTransportSchema,
  argvSchema,
  httpRequestTemplateSchema,
  responseExtractionSchema,
  jsonlBridgeTransportSchema,
  streamIncrementalOutputModeSchema,
  streamTransportSchema,
  vercelSandboxSchema,
  type AgentTransport,
  type Argv,
  type HttpRequestTemplate,
  type ResponseExtraction,
  type VercelSandbox,
};
