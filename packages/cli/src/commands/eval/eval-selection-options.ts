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
const addEvalSelectionOptions = (command: Command): Command =>
  command
    .option('--case <case-id>', 'select an exact case id; repeatable', collect)
    .option('--tag <tag>', 'select cases with every repeated tag; repeatable', collect)
    .option('--folder <folder>', 'select a logical folder and descendants; repeatable', collect)
    .option('--dataset <dataset-id>', 'select cases from an attached dataset; repeatable', collect);

/** Translates Commander option names into the eval request field names. */
const evalSelectionFields = (options: EvalSelectionOptions) => ({
  caseIds: options.case,
  datasetIds: options.dataset,
  folders: options.folder,
  tags: options.tag,
});

export { addEvalSelectionOptions, evalSelectionFields, type EvalSelectionOptions };
