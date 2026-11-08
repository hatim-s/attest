import { promptWithSignal } from '../shared/required-input.js';
import * as Effect from 'effect/Effect';
import { isJsonObject } from '@attest/contracts';
import { LocalError } from '@attest/local';
import {
  CURL_MAPPING_DIAGNOSTICS,
  findUnboundCurlCredential,
  pollingFlagsPresent,
  type CurlImportFields,
} from '@attest/local/agent';

import { commaSeparated, promptChoice, promptDefault, promptOptional } from './agent-prompts.js';
import { requiredInput, type PromptContext } from '../shared/required-input.js';

type CurlFlags = Omit<CurlImportFields, 'responsePointer'> & { responsePointer?: string };

/** Most credential bindings a guided import asks for before handing the source to the parser. */
const MAX_CREDENTIAL_PROMPTS = 32;

/** Asks for an environment variable for every captured credential that still lacks one. */
const promptCredentialBindings = Effect.fn('promptCredentialBindings')(function* (
  fields: CurlFlags,
  curlSource: string,
  context: PromptContext,
): Effect.fn.Return<CurlFlags, Error> {
  let headerEnv = [...(fields.headerEnv ?? [])];
  let queryEnv = [...(fields.queryEnv ?? [])];

  // Reparse after each binding; the captured value is never copied into a prompt.
  for (let asked = 0; asked < MAX_CREDENTIAL_PROMPTS; asked += 1) {
    const credential = yield* Effect.try({
      try: () => findUnboundCurlCredential(curlSource, { headerEnv, queryEnv }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error('Credential parsing failed.', { cause }),
    });

    if (credential === undefined) break;
    const flag = credential.kind === 'header' ? '--header-env' : '--query-env';
    const label = credential.kind === 'header' ? 'Header' : 'Query';

    const environment = yield* requiredInput(
      undefined,
      { path: flag, question: `${label} ${credential.name} environment variable: ` },
      context,
    );

    const binding = `${credential.name}=${environment}`;

    if (credential.kind === 'header') headerEnv = [...headerEnv, binding];
    else queryEnv = [...queryEnv, binding];
  }

  return { ...fields, headerEnv, queryEnv };
});

/** Asks how the polling submission reports its job and where to poll for status. */
const promptPollingFields = Effect.fn('promptPollingFields')(function* (
  fields: CurlFlags,
  context: PromptContext,
): Effect.fn.Return<CurlFlags, Error> {
  const polling: CurlFlags = {
    ...fields,
    pollJobIdPointer: yield* promptDefault(
      fields.pollJobIdPointer,
      'Submission job id JSON Pointer',
      '/job_id',
      context,
    ),
  };

  if (fields.pollStatusUrlPointer === undefined && fields.pollStatusUrlTemplate === undefined) {
    const statusSource = yield* promptChoice(
      'Status URL source',
      ['pointer', 'template'],
      'pointer',
      'status-url-source',
      context,
    );

    if (statusSource === 'pointer') {
      polling.pollStatusUrlPointer = yield* promptDefault(
        undefined,
        'Submission status URL JSON Pointer',
        '/status_url',
        context,
      );
    } else {
      polling.pollStatusUrlTemplate = yield* requiredInput(
        undefined,
        {
          path: '--poll-status-url-template',
          question: 'Same-origin status URL template with {{job_id}}: ',
        },
        context,
      );
    }
  }

  polling.pollStatusPointer = yield* promptDefault(
    fields.pollStatusPointer,
    'Polling status JSON Pointer',
    '/status',
    context,
  );
  polling.pollSuccess = fields.pollSuccess ??
    commaSeparated(
      yield* promptWithSignal(
        context.prompt,
        'Polling success JSON values, comma-separated ["done"]: ',
        context.signal,
      ),
    ) ?? ['"done"'];
  polling.pollFailure = fields.pollFailure ??
    commaSeparated(
      yield* promptWithSignal(
        context.prompt,
        'Polling failure JSON values, comma-separated ["failed"]: ',
        context.signal,
      ),
    ) ?? ['"failed"'];
  polling.pollMinimumInterval = yield* promptDefault(
    fields.pollMinimumInterval,
    'Minimum polling interval',
    '1s',
    context,
  );
  polling.pollMaximumInterval = yield* promptDefault(
    fields.pollMaximumInterval,
    'Maximum polling interval',
    '5s',
    context,
  );
  polling.idempotencyHeader = yield* promptOptional(
    fields.idempotencyHeader,
    'Submission idempotency header',
    context,
  );

  return polling;
});

/**
 * Completes a cURL import interactively: credential bindings, body mappings, response pointers,
 * and the polling shape. Returns the flags unchanged outside an interactive terminal.
 */
const promptCurlImportFields = Effect.fn('promptCurlImportFields')(function* (
  fields: CurlFlags,
  curlSource: string,
  context: PromptContext,
): Effect.fn.Return<CurlImportFields, Error> {
  if (!context.interactive) {
    return { ...fields, responsePointer: fields.responsePointer ?? '/answer' };
  }

  let guided = yield* promptCredentialBindings(fields, curlSource, context);

  if (fields.mapBody === undefined) {
    guided.mapBody = commaSeparated(
      yield* promptWithSignal(
        context.prompt,
        'Body mappings TARGET_POINTER=INPUT_POINTER, comma-separated [none]: ',
        context.signal,
      ),
    );
  }

  guided.errorPointer = yield* promptOptional(fields.errorPointer, 'Error JSON Pointer', context);
  guided.tracePointer = yield* promptOptional(fields.tracePointer, 'Trace JSON Pointer', context);
  guided.remoteJobIdPointer = yield* promptOptional(
    fields.remoteJobIdPointer,
    'Remote job id JSON Pointer',
    context,
  );

  const transport = pollingFlagsPresent(fields)
    ? 'polling'
    : yield* promptChoice('Transport', ['direct', 'polling'], 'direct', 'transport', context);

  if (transport === 'polling') guided = yield* promptPollingFields(guided, context);

  return {
    ...guided,
    responsePointer: yield* promptDefault(
      fields.responsePointer,
      'Response JSON Pointer',
      '/answer',
      context,
    ),
  };
});

/** True when an import failed on a body mapping the user can re-enter. */
const isCurlMappingError = (cause: unknown): cause is LocalError => {
  if (!(cause instanceof LocalError)) return false;
  const details = cause.details;

  if (!isJsonObject(details)) return false;
  const diagnostics = details.diagnostics;

  return (
    Array.isArray(diagnostics) &&
    diagnostics.some(
      (diagnostic): diagnostic is string =>
        typeof diagnostic === 'string' && CURL_MAPPING_DIAGNOSTICS.has(diagnostic),
    )
  );
};

/** Asks for replacement body mappings after an import rejected the previous ones. */
const promptBodyMappings = Effect.fn('promptBodyMappings')(function* (
  context: PromptContext,
): Effect.fn.Return<string[] | undefined, Error> {
  return commaSeparated(
    yield* promptWithSignal(
      context.prompt,
      'Body mapping was invalid. Re-enter TARGET_POINTER=INPUT_POINTER values [none]: ',
      context.signal,
    ),
  );
});

export { isCurlMappingError, promptBodyMappings, promptCurlImportFields, type CurlFlags };
