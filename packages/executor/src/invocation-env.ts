import { AGENT_PROTOCOL } from '@attest/contracts';
import { delimiter, isAbsolute, join } from 'node:path';

/** Removes relative and empty search entries so executable lookup cannot escape the opted-in host path. */
const resolveSafePath = (parentPath: string | undefined): string => {
  return (parentPath ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
};

/**
 * Resolves the isolated CLI environment required by docs/specs/agent-contract.md. Credentials and
 * temporary state default beneath the attempt directory; only explicit allowlisting can replace them.
 */
const resolveInvocationEnv = (
  allowlist: readonly string[],
  parentEnv: NodeJS.ProcessEnv,
  attest: { runId: string; caseId: string },
  attemptDirectory: string,
): Record<string, string> => {
  const environment: Record<string, string> = {
    PATH: resolveSafePath(parentEnv.PATH),
    HOME: join(attemptDirectory, 'home'),
    TMPDIR: join(attemptDirectory, 'tmp'),
    LC_ALL: 'C',
  };
  for (const key of allowlist) {
    const value = parentEnv[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.ATTEST_RUN_ID = attest.runId;
  environment.ATTEST_CASE_ID = attest.caseId;
  environment.ATTEST_PROTOCOL = AGENT_PROTOCOL;
  return environment;
};

export { resolveInvocationEnv };
