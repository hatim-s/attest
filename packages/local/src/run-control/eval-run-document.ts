import { COMMAND_REQUEST_SCHEMA_ID, type EvalRunRequest } from '@attest/contracts';
import type { RunStartRequest } from '@attest/core/records';

/**
 * Maps the dashboard's request to the CLI's `eval.run` document. The output is always JSONL so
 * the launcher can read the `run_started` event; the CLI validates the document as its own input.
 */
const toEvalRunDocument = ({
  selection,
  tags,
  concurrency,
  timeoutMs,
}: RunStartRequest): EvalRunRequest => {
  const fields = {
    schema: COMMAND_REQUEST_SCHEMA_ID,
    command: 'eval.run',
    output: 'jsonl',
    tags,
    concurrency,
    timeout_ms: timeoutMs,
  } as const;

  return 'all' in selection ? { ...fields, all: true } : { ...fields, test_ids: selection.testIds };
};

export { toEvalRunDocument };
