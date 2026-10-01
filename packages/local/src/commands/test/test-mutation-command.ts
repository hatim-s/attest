import { loadProject } from '../../project/project-loader/index.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { executeProjectMutation } from '../shared/project-mutation.js';
import { loadCommandProject } from '../project/load-command-project.js';

import { buildMutation, type TestMutationCommandOptions } from './test-mutation-build.js';

/** Executes one normalized authoring request through the shared hash-guarded transaction writer. */
const runTestMutationCommand = async (
  options: TestMutationCommandOptions,
): Promise<CommandResult<'mutation', MutationResult>> => {
  // A preview must not recover journals or acquire a reader lock because that would write locally.
  const loaded =
    options.request.dry_run === true
      ? await loadProject({ project: options.project, workingDirectory: options.workingDirectory })
      : await loadCommandProject({
          project: options.project,
          workingDirectory: options.workingDirectory,
        });
  const built = await buildMutation(loaded, options.request, options);
  const mutation = await executeProjectMutation({
    dryRun: options.request.dry_run === true,
    mutation: {
      candidate: built.candidate,
      // Always bind the candidate to its loaded base; an explicit caller hash is stricter still.
      expectedProjectHash: options.request.if_project_hash ?? loaded.projectHash,
      projectRoot: loaded.root,
      renames: built.renames,
      warnings: built.warnings?.map(({ message }) => message),
    },
  });
  const dryRun = options.request.dry_run === true;
  return {
    operation: 'mutation',
    projectHashBefore: mutation.projectHashBefore,
    projectHashAfter: mutation.projectHashAfter,
    result: {
      committed: mutation.committed,
      dry_run: dryRun,
      resource: built.resource,
      operations: mutation.diff.operations,
      ...(built.affectedTests === undefined ? {} : { affected_tests: built.affectedTests }),
      ...(built.importedCaseCount === undefined
        ? {}
        : { imported_case_count: built.importedCaseCount }),
      ...(built.importResult === undefined
        ? {}
        : {
            import: {
              format: built.importResult.format,
              counts: built.importResult.counts,
              decisions: built.importResult.decisions,
              preview: built.importResult.preview,
              source_content_hash: built.importResult.sourceHash,
            },
          }),
    },
    warnings: built.warnings,
  };
};

export { runTestMutationCommand };
