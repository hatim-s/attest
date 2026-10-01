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
const promptCredentialBindings = async (
  fields: CurlFlags,
  curlSource: string,
  context: PromptContext,
): Promise<CurlFlags> => {
  let headerEnv = [...(fields.headerEnv ?? [])];
  let queryEnv = [...(fields.queryEnv ?? [])];
  // Reparse after each binding; the captured value is never copied into a prompt.
  for (let asked = 0; asked < MAX_CREDENTIAL_PROMPTS; asked += 1) {
    const credential = findUnboundCurlCredential(curlSource, { headerEnv, queryEnv });
    if (credential === undefined) break;
    const flag = credential.kind === 'header' ? '--header-env' : '--query-env';
    const label = credential.kind === 'header' ? 'Header' : 'Query';
    const environment = await requiredInput(
      undefined,
      { path: flag, question: `${label} ${credential.name} environment variable: ` },
      context,
    );
    const binding = `${credential.name}=${environment}`;
    if (credential.kind === 'header') headerEnv = [...headerEnv, binding];
    else queryEnv = [...queryEnv, binding];
  }
  return { ...fields, headerEnv, queryEnv };
};

/** Asks how the polling submission reports its job and where to poll for status. */
const promptPollingFields = async (
  fields: CurlFlags,
  context: PromptContext,
): Promise<CurlFlags> => {
  const polling: CurlFlags = {
    ...fields,
    pollJobIdPointer: await promptDefault(
      fields.pollJobIdPointer,
      'Submission job id JSON Pointer',
      '/job_id',
      context,
    ),
  };
  if (fields.pollStatusUrlPointer === undefined && fields.pollStatusUrlTemplate === undefined) {
    const statusSource = await promptChoice(
      'Status URL source',
      ['pointer', 'template'],
      'pointer',
      'status-url-source',
      context,
    );
    if (statusSource === 'pointer') {
      polling.pollStatusUrlPointer = await promptDefault(
        undefined,
        'Submission status URL JSON Pointer',
        '/status_url',
        context,
      );
    } else {
      polling.pollStatusUrlTemplate = await requiredInput(
        undefined,
        {
          path: '--poll-status-url-template',
          question: 'Same-origin status URL template with {{job_id}}: ',
        },
        context,
      );
    }
  }
  polling.pollStatusPointer = await promptDefault(
    fields.pollStatusPointer,
    'Polling status JSON Pointer',
    '/status',
    context,
  );
  polling.pollSuccess = fields.pollSuccess ??
    commaSeparated(
      await context.prompt('Polling success JSON values, comma-separated ["done"]: '),
    ) ?? ['"done"'];
  polling.pollFailure = fields.pollFailure ??
    commaSeparated(
      await context.prompt('Polling failure JSON values, comma-separated ["failed"]: '),
    ) ?? ['"failed"'];
  polling.pollMinimumInterval = await promptDefault(
    fields.pollMinimumInterval,
    'Minimum polling interval',
    '1s',
    context,
  );
  polling.pollMaximumInterval = await promptDefault(
    fields.pollMaximumInterval,
    'Maximum polling interval',
    '5s',
    context,
  );
  polling.idempotencyHeader = await promptOptional(
    fields.idempotencyHeader,
    'Submission idempotency header',
    context,
  );
  return polling;
};

/**
 * Completes a cURL import interactively: credential bindings, body mappings, response pointers,
 * and the polling shape. Returns the flags unchanged outside an interactive terminal.
 */
const promptCurlImportFields = async (
  fields: CurlFlags,
  curlSource: string,
  context: PromptContext,
): Promise<CurlImportFields> => {
  if (!context.interactive) {
    return { ...fields, responsePointer: fields.responsePointer ?? '/answer' };
  }
  let guided = await promptCredentialBindings(fields, curlSource, context);
  if (fields.mapBody === undefined) {
    guided.mapBody = commaSeparated(
      await context.prompt('Body mappings TARGET_POINTER=INPUT_POINTER, comma-separated [none]: '),
    );
  }
  guided.errorPointer = await promptOptional(fields.errorPointer, 'Error JSON Pointer', context);
  guided.tracePointer = await promptOptional(fields.tracePointer, 'Trace JSON Pointer', context);
  guided.remoteJobIdPointer = await promptOptional(
    fields.remoteJobIdPointer,
    'Remote job id JSON Pointer',
    context,
  );
  const transport = pollingFlagsPresent(fields)
    ? 'polling'
    : await promptChoice('Transport', ['direct', 'polling'], 'direct', 'transport', context);
  if (transport === 'polling') guided = await promptPollingFields(guided, context);
  return {
    ...guided,
    responsePointer: await promptDefault(
      fields.responsePointer,
      'Response JSON Pointer',
      '/answer',
      context,
    ),
  };
};

/** True when an import failed on a body mapping the user can re-enter. */
const isCurlMappingError = (error: unknown): boolean => {
  if (!(error instanceof LocalError)) return false;
  const details = error.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return false;
  const diagnostics = details.diagnostics;
  return (
    Array.isArray(diagnostics) &&
    diagnostics.some(
      (diagnostic) => typeof diagnostic === 'string' && CURL_MAPPING_DIAGNOSTICS.has(diagnostic),
    )
  );
};

/** Asks for replacement body mappings after an import rejected the previous ones. */
const promptBodyMappings = async (context: PromptContext): Promise<string[] | undefined> =>
  commaSeparated(
    await context.prompt(
      'Body mapping was invalid. Re-enter TARGET_POINTER=INPUT_POINTER values [none]: ',
    ),
  );

export { isCurlMappingError, promptBodyMappings, promptCurlImportFields, type CurlFlags };
