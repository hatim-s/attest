import { AGENT_PROTOCOL, type AgentRequest, type CaseDefinition } from '@attest/contracts';

const BASE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

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
 * Resolves the CLI environment required by docs/specs/agent-contract.md. The minimal base set is
 * always forwarded so executable lookup, home discovery, temporary files, and locale-sensitive
 * runtimes keep working; configured keys remain an explicit allowlist and absent values are skipped.
 */
const resolveInvocationEnv = (
  allowlist: readonly string[] | undefined,
  base: NodeJS.ProcessEnv,
  attest: { runId: string; caseId: string },
): Record<string, string> => {
  const environment: Record<string, string> = {};
  copyPresentEnvironmentKeys(environment, BASE_ENV_KEYS, base);
  copyPresentEnvironmentKeys(environment, allowlist ?? [], base);
  environment.ATTEST_RUN_ID = attest.runId;
  environment.ATTEST_CASE_ID = attest.caseId;
  environment.ATTEST_PROTOCOL = AGENT_PROTOCOL;
  return environment;
};

export { buildAgentRequest, resolveInvocationEnv };
