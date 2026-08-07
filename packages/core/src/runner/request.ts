import { AGENT_PROTOCOL, type AgentRequest, type CaseDefinition } from '@attest/contracts';
import { delimiter, isAbsolute, join } from 'node:path';

const copyPresentEnvironmentKeys = (
  destination: Record<string, string>,
  keys: readonly string[],
  base: NodeJS.ProcessEnv,
): void => {
  for (const key of keys) {
    const value = base[key];
    if (value !== undefined) {
      destination[key] = value;
    }
  }
};

/** Removes relative and empty search entries so executable lookup cannot escape the opted-in host path. */
const resolveSafePath = (parentPath: string | undefined): string => {
  return (parentPath ?? '')
    .split(delimiter)
    .filter((entry) => isAbsolute(entry))
    .join(delimiter);
};

/**
 * Builds the Phase 1 single-turn request envelope from docs/specs/agent-contract.md, deliberately
 * omitting all conversation fields until the multi-turn phase owns their lifecycle.
 */
const buildAgentRequest = (runId: string, caseDefinition: CaseDefinition): AgentRequest => {
  const request: AgentRequest = {
    protocol: AGENT_PROTOCOL,
    run_id: runId,
    case_id: caseDefinition.id,
    input: caseDefinition.input,
  };

  if (caseDefinition.params !== undefined) {
    request.params = caseDefinition.params;
  }

  return request;
};

/**
 * Resolves the isolated CLI environment required by docs/specs/agent-contract.md. Credentials and
 * temporary state default beneath the attempt directory; only explicit allowlisting can replace them.
 */
const resolveInvocationEnv = (
  allowlist: readonly string[] | undefined,
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
  copyPresentEnvironmentKeys(environment, allowlist ?? [], parentEnv);
  environment.ATTEST_RUN_ID = attest.runId;
  environment.ATTEST_CASE_ID = attest.caseId;
  environment.ATTEST_PROTOCOL = AGENT_PROTOCOL;
  return environment;
};

export { buildAgentRequest, resolveInvocationEnv };
