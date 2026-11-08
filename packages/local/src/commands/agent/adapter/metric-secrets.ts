import * as Effect from 'effect/Effect';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import type { SecretReference } from '@attest/contracts';
import { LocalError } from '../../../errors/index.js';
import { openAnchored } from '../../../internal/open-anchored.js';
import { isLiteralTemplateValue } from '../../../internal/template-value.js';
import { isProjectPath } from '../../../project/project-path.js';
import { foreign, withRelease } from './metric-operation.js';

/** Reads a secret reference at invocation time without returning its source path or value. */
const readSecretReference = (
  reference: SecretReference,
  projectRoot: string,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    if ('from_env' in reference) {
      const value = process.env[reference.from_env];

      if (value === undefined) {
        return yield* Effect.fail(
          new LocalError('invocation_failed', 'A referenced environment secret is missing.', {
            path: reference.from_env,
            hint: 'Set the referenced environment variable and retry the connection test.',
          }),
        );
      }

      return value;
    }

    const candidate = resolve(projectRoot, reference.from_file);

    if (!isProjectPath(projectRoot, candidate)) {
      return yield* Effect.fail(
        new LocalError('invocation_failed', 'A secret file is outside the project.', {
          path: reference.from_file,
          hint: 'Use a project-contained secret file or an environment reference.',
        }),
      );
    }

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const opened = yield* openAnchored(candidate, { kind: 'file', root: projectRoot });

        return yield* withRelease(
          restore(
            Effect.gen(function* () {
              if ((opened.identity.mode & 0o077n) !== 0n)
                return yield* Effect.fail(
                  new Error('secret file must not be readable by group or others'),
                );

              return yield* foreign(() => opened.handle.readFile('utf8'));
            }),
          ),
          foreign(() => opened.handle.close()),
        );
      }),
    ).pipe(
      // A failed secret read never joins the redaction list, so its value cannot be error evidence.
      Effect.catchTag('LocalMetricCleanupError', (error) =>
        Effect.fail(
          new Error('Secret file descriptor cleanup failed.', { cause: error.cleanupCause }),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new LocalError('invocation_failed', 'A referenced secret file is unavailable.', {
            path: reference.from_file,
            hint: 'Use a project-contained regular file with group/world permissions removed.',
            cause,
          }),
      ),
    );
  });

/** Builds the minimum safe inherited environment used by the hardened native CLI invoker. */
const createBaseEnvironment = () => ({
  PATH: (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter),
  LC_ALL: 'C',
  TMPDIR: tmpdir(),
});

type ResolvedProcessEnvironment = {
  env: Record<string, string>;
  /** Only the referenced variables, for a sandbox that must not inherit the host base. */
  variables: Record<string, string>;
  secrets: string[];
};

/**
 * Builds a child process environment from the hardened base plus secret references read at
 * invocation time. Returns the secret values too so every evidence path can redact them.
 */
const resolveProcessEnvironment = (
  references: Readonly<Record<string, SecretReference>> | undefined,
  projectRoot: string,
): Effect.Effect<ResolvedProcessEnvironment, Error> =>
  Effect.gen(function* () {
    const variables: ResolvedProcessEnvironment['variables'] = {};
    const secrets: string[] = [];

    for (const [name, reference] of Object.entries(references ?? {})) {
      const value = yield* readSecretReference(reference, projectRoot);
      variables[name] = value;
      secrets.push(value);
    }

    return { env: { ...createBaseEnvironment(), ...variables }, variables, secrets };
  });

type ResolvedRequestSecrets = {
  headers: Record<string, string>;
  query: Record<string, string>;
  secrets: string[];
};

/** Resolves one request template's secret references without changing the authored resource. */
const resolveHttpSecrets = (
  request: {
    headers?: Record<string, string | SecretReference>;
    query?: Record<string, string | SecretReference>;
  },
  projectRoot: string,
): Effect.Effect<ResolvedRequestSecrets, Error> =>
  Effect.gen(function* () {
    const resolveValues = (
      values: Record<string, string | SecretReference> | undefined,
      secrets: string[],
    ): Effect.Effect<Record<string, string>, Error> =>
      Effect.gen(function* () {
        const resolved: Record<string, string> = {};

        for (const [name, value] of Object.entries(values ?? {})) {
          if (isLiteralTemplateValue(value)) {
            resolved[name] = value;
            continue;
          }

          resolved[name] = yield* readSecretReference(value, projectRoot);
          secrets.push(resolved[name]);
        }

        return resolved;
      });

    const secrets: string[] = [];
    const headers = yield* resolveValues(request.headers, secrets);
    const query = yield* resolveValues(request.query, secrets);

    return { headers, query, secrets };
  });

export { createBaseEnvironment, resolveProcessEnvironment, resolveHttpSecrets };
