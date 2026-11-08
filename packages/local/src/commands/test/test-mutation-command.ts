import * as Effect from 'effect/Effect';
import { loadProject } from '../../project/project-loader/index.js';
import type { CommandResult, MutationResult } from '../shared/command-result.js';
import { executeProjectMutation } from '../shared/project-mutation.js';
import { loadCommandProject } from '../project/load-command-project.js';

import { buildMutation, type TestMutationCommandOptions } from './test-mutation-build.js';

/** Executes one normalized authoring request through the shared hash-guarded transaction writer. */
const runTestMutationCommand = Effect.fn('runTestMutationCommand')(function* (
  options: TestMutationCommandOptions,
) {
  // A preview must not recover journals or acquire a reader lock because that would write locally.
  const loaded = yield* options.request.dry_run === true
    ? loadProject({ project: options.project, workingDirectory: options.workingDirectory })
    : loadCommandProject({
        project: options.project,
        workingDirectory: options.workingDirectory,
      });

  const built = yield* buildMutation(loaded, options.request, options);

  const mutation = yield* executeProjectMutation({
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

  const result: MutationResult = {
    committed: mutation.committed,
    dry_run: dryRun,
    resource: built.resource,
    operations: mutation.diff.operations,
  };

  if (built.affectedTests !== undefined) {
    result.affected_tests = built.affectedTests;
  }

  if (built.importedCaseCount !== undefined) {
    result.imported_case_count = built.importedCaseCount;
  }

  if (built.importResult !== undefined) {
    result.import = {
      format: built.importResult.format,
      counts: built.importResult.counts,
      decisions: built.importResult.decisions,
      preview: built.importResult.preview,
      source_content_hash: built.importResult.sourceHash,
    };
  }

  return {
    operation: 'mutation' as const,
    projectHashBefore: mutation.projectHashBefore,
    projectHashAfter: mutation.projectHashAfter,
    result,

    warnings: built.warnings,
  } satisfies CommandResult<'mutation', MutationResult>;
});

export { runTestMutationCommand };
