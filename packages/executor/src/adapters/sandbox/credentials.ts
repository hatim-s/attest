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

  const present = requiredAccessTokenKeys.filter((key) => nonEmpty(environment[key]));
  if (present.length !== requiredAccessTokenKeys.length) {
    const missing = requiredAccessTokenKeys.filter((key) => !nonEmpty(environment[key]));
    const message =
      present.length === 0
        ? 'Vercel Sandbox requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.'
        : `Vercel Sandbox access-token credentials are incomplete. Missing: ${missing.join(', ')}.`;
    throw new AgentInvocationError('spawn_failed', message);
  }

  return {
    kind: 'access_token',
    credentials: {
      token: environment.VERCEL_TOKEN as string,
      teamId: environment.VERCEL_TEAM_ID as string,
      projectId: environment.VERCEL_PROJECT_ID as string,
    },
  };
};

export { resolveVercelSandboxCredentials };
export type { VercelSandboxCredentials };
