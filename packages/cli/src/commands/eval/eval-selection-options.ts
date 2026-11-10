import type { Command } from 'commander';
import { collect } from '../shared/cli-options.js';
import type { EvalRunRequestFields } from './eval-request.js';

type EvalSelectionOptions = {
  case?: EvalRunRequestFields['caseIds'];
  dataset?: EvalRunRequestFields['datasetIds'];
  folder?: EvalRunRequestFields['folders'];
  tag?: EvalRunRequestFields['tags'];
};

/** Registers the same repeatable selection filters for local and hosted runs. */
const addEvalSelectionOptions = (
  command: Command,
  descriptions: {
    case: [string, string];
    tag: [string, string];
    folder: [string, string];
    dataset: [string, string];
  },
): Command =>
  command
    .option(...descriptions.case, collect)
    .option(...descriptions.tag, collect)
    .option(...descriptions.folder, collect)
    .option(...descriptions.dataset, collect);

/** Translates Commander option names into the eval request field names. */
const evalSelectionFields = (options: EvalSelectionOptions) => ({
  caseIds: options.case,
  datasetIds: options.dataset,
  folders: options.folder,
  tags: options.tag,
});

export { addEvalSelectionOptions, evalSelectionFields, type EvalSelectionOptions };
