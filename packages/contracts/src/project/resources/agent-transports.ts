import { z } from 'zod';

import {
  durationMillisecondsSchema,
  jsonPointerSchema,
  refinePollingSchedule,
  relativePathSchema,
  secretReferenceSchema,
} from '../shared.js';
import { reportDuplicates } from '../../internal/duplicates.js';
import { webSocketTransportSchema } from '../../agent/websocket-contract.js';

const httpUrlTemplateSchema = z
  .string()
  .regex(/^https?:\/\/\S+$/u, 'must be an HTTP or HTTPS URL template');
const templateValueSchema = z.union([z.string(), secretReferenceSchema]);

/** Builds a foreign HTTP request before normalization at the runner boundary. */
const httpRequestTemplateSchema = z
  .strictObject({
    url: httpUrlTemplateSchema,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    headers: z.record(z.string(), templateValueSchema).optional(),
    query: z.record(z.string(), templateValueSchema).optional(),
    body: z.json().optional(),
    body_encoding: z.enum(['json', 'raw']).optional(),
  })
  .superRefine((request, context) => {
    if (request.body_encoding === 'raw' && typeof request.body !== 'string') {
      context.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'must be a string when body_encoding is raw',
      });
    }
    if (request.body === undefined && request.body_encoding !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['body_encoding'],
        message: 'requires a body',
      });
    }
  })
  .meta({ id: 'HttpRequestTemplate' });

/** Extracts a normalized agent outcome from a foreign response or terminal event. */
const responseExtractionSchema = z
  .strictObject({
    result_pointer: jsonPointerSchema,
    error_pointer: jsonPointerSchema.optional(),
    trace_pointer: jsonPointerSchema.optional(),
    remote_job_id_pointer: jsonPointerSchema.optional(),
  })
  .meta({ id: 'ResponseExtraction' });

const processEnvironmentSchema = z.record(z.string(), secretReferenceSchema);

const literalRelativePathSchema = relativePathSchema.regex(
  /^[^*?\[\]{}]+$/u,
  'must not contain glob metacharacters',
);

/** Uploads one project file into a Vercel sandbox before agent invocation. */
const vercelSandboxFileSchema = z.strictObject({
  source: literalRelativePathSchema,
  destination: literalRelativePathSchema,
  mode: z.number().int().min(0).max(0o777).optional(),
});

/** Copies one sandbox artifact back into the project after agent invocation. */
const vercelSandboxArtifactSchema = z.strictObject({
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
const vercelSandboxSchema = z
  .strictObject({
    kind: z.literal('vercel'),
    image: z.string().min(1).optional(),
    files: z.array(vercelSandboxFileSchema),
    artifacts: z.array(vercelSandboxArtifactSchema).optional(),
    artifact_directory: relativePathSchema.optional(),
  })
  .superRefine((sandbox, context) => {
    // Aliased destinations would overwrite sandbox files or host artifacts.
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
  });

const nativeForegroundTransportSchema = z.strictObject({
  kind: z.literal('native_cli'),
  lifecycle: z.literal('per_case'),
  argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: processEnvironmentSchema.optional(),
  sandbox: vercelSandboxSchema.optional(),
});

const backgroundReadinessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('http'), url: httpUrlTemplateSchema }),
  z.strictObject({
    kind: z.literal('tcp'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  }),
  z.strictObject({ kind: z.literal('stderr'), pattern: z.string().min(1).max(512) }),
]);

const nativeBackgroundTransportSchema = z.strictObject({
  kind: z.literal('background_cli'),
  lifecycle: z.literal('per_run'),
  start_argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: processEnvironmentSchema.optional(),
  readiness: backgroundReadinessSchema,
  invoke: httpRequestTemplateSchema,
  extraction: responseExtractionSchema,
  shutdown: httpRequestTemplateSchema.optional(),
  stop_timeout_ms: durationMillisecondsSchema,
});

const jsonlBridgeTransportSchema = z.strictObject({
  kind: z.literal('jsonl_bridge'),
  lifecycle: z.literal('per_run'),
  argv: z.array(z.string()).nonempty(),
  cwd: relativePathSchema.optional(),
  env: processEnvironmentSchema.optional(),
  concurrency: z.enum(['serial', 'multiplexed']),
  cancellation_grace_ms: durationMillisecondsSchema,
});

const httpTransportSchema = z.strictObject({
  kind: z.literal('http'),
  lifecycle: z.literal('external'),
  response_mode: z.enum(['attest_envelope', 'mapped']),
  request: httpRequestTemplateSchema,
  extraction: responseExtractionSchema,
});

const pollingTransportSchema = z
  .strictObject({
    kind: z.literal('polling'),
    lifecycle: z.literal('external'),
    submit: httpRequestTemplateSchema,
    idempotency_header: z.string().min(1).optional(),
    job_id_pointer: jsonPointerSchema,
    status_url_pointer: jsonPointerSchema.optional(),
    status_url_template: httpUrlTemplateSchema.optional(),
    status_pointer: jsonPointerSchema,
    success_values: z.array(z.json()).nonempty(),
    failure_values: z.array(z.json()).nonempty(),
    extraction: responseExtractionSchema,
    minimum_interval_ms: durationMillisecondsSchema,
    maximum_interval_ms: durationMillisecondsSchema,
  })
  .superRefine(refinePollingSchedule);

const streamTransportSchema = z
  .strictObject({
    kind: z.literal('stream'),
    lifecycle: z.literal('external'),
    framing: z.enum(['sse', 'jsonl']),
    request: httpRequestTemplateSchema,
    event_name: z.string().min(1).optional(),
    event_data_pointer: jsonPointerSchema.optional(),
    terminal_pointer: jsonPointerSchema,
    terminal_values: z.array(z.json()).nonempty(),
    result_pointer: jsonPointerSchema,
    error_pointer: jsonPointerSchema.optional(),
    trace_pointer: jsonPointerSchema.optional(),
    incremental_output_pointer: jsonPointerSchema.optional(),
    incremental_output_mode: z.enum(['text', 'array']).optional(),
    heartbeat_resets_application_idle: z.boolean().optional(),
  })
  .superRefine((stream, context) => {
    if (
      (stream.incremental_output_pointer === undefined) !==
      (stream.incremental_output_mode === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['incremental_output_mode'],
        message: 'must be provided together with incremental_output_pointer',
      });
    }
  });

/** Encodes every supported agent transport definition. */
const agentTransportSchema = z.discriminatedUnion('kind', [
  nativeForegroundTransportSchema,
  nativeBackgroundTransportSchema,
  jsonlBridgeTransportSchema,
  httpTransportSchema,
  pollingTransportSchema,
  streamTransportSchema,
  webSocketTransportSchema,
]);

type AgentTransport = z.infer<typeof agentTransportSchema>;
type HttpRequestTemplate = z.infer<typeof httpRequestTemplateSchema>;
type ResponseExtraction = z.infer<typeof responseExtractionSchema>;
type VercelSandbox = z.infer<typeof vercelSandboxSchema>;

export {
  agentTransportSchema,
  httpRequestTemplateSchema,
  responseExtractionSchema,
  vercelSandboxSchema,
  type AgentTransport,
  type HttpRequestTemplate,
  type ResponseExtraction,
  type VercelSandbox,
};
