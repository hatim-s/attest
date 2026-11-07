import * as Effect from 'effect/Effect';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import {
  vercelSandboxIsolation,
  type CaseEnvironment,
  type CaseEnvironmentFactory,
} from '@attest/executor';

import { resolveContainedPath } from '../../project/project-path.js';
import type { ResolvedEvalCaseInput } from './eval-resolver.js';

/** Reads a project-contained regular file, or returns undefined for anything else. */
const readProjectFile = Effect.fn(function* (projectRoot: string, path: string) {
  return yield* Effect.gen(function* () {
    const resolved = yield* resolveContainedPath(projectRoot, path, {
      expect: 'file',
      problem: (problem) => new Error(problem),
    });

    return yield* Effect.tryPromise({
      try: () => readFile(resolved, 'utf8'),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error('Project file read failed.', { cause }),
    });
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

/**
 * Runs a case in a Vercel sandbox only when it attaches an exec metric. The sandbox starts with
 * every project file an exec metric's argv names, at the path the argv uses, because the command
 * runs from the workspace root. Other entries, such as `node` or a flag, come from the image. The
 * seed shares the sandbox's `outputBytes` cap, so an oversized script fails the case at start.
 */
const metricSandboxIsolation = (
  projectRoot: string,
  cases: readonly Pick<ResolvedEvalCaseInput, 'configured_index' | 'metrics'>[],
  options: NonNullable<Parameters<typeof vercelSandboxIsolation>[0]>,
): ((
  context: Parameters<CaseEnvironmentFactory>[0],
) => Effect.Effect<CaseEnvironment | undefined, Error>) =>
  Effect.fn(function* (
    context: Parameters<CaseEnvironmentFactory>[0],
  ): Effect.fn.Return<CaseEnvironment | undefined, Error> {
    const payload = cases.find((entry) => entry.configured_index === context.configuredIndex);

    const definitions = (payload?.metrics ?? []).flatMap(({ metric }) =>
      metric.definition.kind === 'exec' ? [metric.definition] : [],
    );

    if (definitions.length === 0) return undefined;
    const files: Record<string, string> = {};

    for (const { argv, cwd } of definitions) {
      for (const argument of argv.filter((entry) => !isAbsolute(entry))) {
        const content = yield* readProjectFile(projectRoot, join(cwd ?? '.', argument));

        if (content !== undefined) files[normalize(argument)] = content;
      }
    }

    return yield* vercelSandboxIsolation({ ...options, files })(context);
  });

export { metricSandboxIsolation };
