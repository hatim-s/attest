import { AgentInvocationError } from '../../errors.js';

type VercelAccessTokenCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

type VercelSandboxCredentials =
  { kind: 'oidc' } | { kind: 'access_token'; credentials: VercelAccessTokenCredentials };

const requiredAccessTokenKeys = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] as const;

const nonEmpty = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

/** Checks one complete credential mode before the adapter creates a sandbox. */
const resolveVercelSandboxCredentials = (
  environment: NodeJS.ProcessEnv,
): VercelSandboxCredentials => {
  if (nonEmpty(environment.VERCEL_OIDC_TOKEN)) return { kind: 'oidc' };

  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = environment;
  if (nonEmpty(token) && nonEmpty(teamId) && nonEmpty(projectId)) {
    return { kind: 'access_token', credentials: { token, teamId, projectId } };
  }

  const missing = requiredAccessTokenKeys.filter((key) => !nonEmpty(environment[key]));
  const message =
    missing.length === requiredAccessTokenKeys.length
      ? 'Vercel Sandbox requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.'
      : `Vercel Sandbox access-token credentials are incomplete. Missing: ${missing.join(', ')}.`;
  throw new AgentInvocationError('spawn_failed', message);
};

export { resolveVercelSandboxCredentials };
export type { VercelSandboxCredentials };
