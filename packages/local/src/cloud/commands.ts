import { createHash, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { cloudRunRequestSchema, type EvalRunRequest } from '@attest/contracts';
import { LocalError } from '../errors/local-error.js';
import { createCloudClient, type CloudClient } from './client.js';
import {
  readCloudCredentials,
  removeCloudCredentials,
  writeCloudCredentials,
} from './credentials.js';

/** Validates untyped server data without carrying its contents into error output. */
const parseCloudResponse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new LocalError(
      'cloud_request_failed',
      'Cloud returned a response that does not match the protocol.',
    );
  return parsed.data;
};

/** Rejects malformed caller input before opening a network request. */
const parseCloudInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new LocalError('cli_usage', 'Cloud request does not match the protocol.');
  return parsed.data;
};

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().positive().max(3600),
  interval: z.number().positive().max(60),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z
    .number()
    .positive()
    .max(366 * 24 * 60 * 60),
});
type LoginNotice = { user_code: string; verification_uri: string; expires_in: number };
type CloudEventPage = {
  events: { sequence: number; time: string; event: string; data: unknown }[];
  next_cursor: number;
};

const eventPageSchema = z.object({
  events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      time: z.string(),
      event: z.string(),
      data: z.unknown(),
    }),
  ),
  next_cursor: z.number().int().nonnegative(),
});

/** Exchanges a user-approved PKCE device session for a private, revocable CLI token. */
const loginCloud = async (options: {
  baseUrl: string;
  credentialPath?: string;
  signal?: AbortSignal;
  onDevice: (notice: LoginNotice) => void;
  fetch?: typeof fetch;
}): Promise<{ base_url: string; authenticated: true }> => {
  const client = createCloudClient({ baseUrl: options.baseUrl, fetch: options.fetch });
  const verifier = randomBytes(32).toString('base64url');
  const device = parseCloudResponse(
    deviceSchema,
    await client.request(
      'POST',
      '/v1/auth/device',
      { code_challenge: createHash('sha256').update(verifier).digest('base64url') },
      options.signal,
    ),
  );
  if (new URL(device.verification_uri).origin !== client.baseUrl)
    throw new LocalError('cloud_request_failed', 'Cloud approval URL points to another origin.');
  options.onDevice({
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    expires_in: device.expires_in,
  });
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new LocalError('cancelled', 'Cloud login cancelled.');
    try {
      const token = parseCloudResponse(
        tokenSchema,
        await client.request(
          'POST',
          '/v1/auth/device/token',
          { device_code: device.device_code, code_verifier: verifier },
          options.signal,
        ),
      );
      await writeCloudCredentials(
        {
          baseUrl: client.baseUrl,
          accessToken: token.access_token,
          expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        },
        options.credentialPath,
      );
      return { base_url: client.baseUrl, authenticated: true };
    } catch (error) {
      if (
        !(error instanceof LocalError) ||
        typeof error.details !== 'object' ||
        error.details === null ||
        Array.isArray(error.details) ||
        error.details.remote_code !== 'authorization_pending'
      )
        throw error;
    }
    try {
      await setTimeout(
        Math.min(device.interval * 1000, Math.max(0, deadline - Date.now())),
        undefined,
        { signal: options.signal },
      );
    } catch {
      throw new LocalError('cancelled', 'Cloud login cancelled.');
    }
  }
  throw new LocalError(
    'cloud_auth_required',
    'Cloud approval code expired. Run cloud login again.',
  );
};

/** Loads only credentials tied to the configured cloud origin. */
const authenticatedCloudClient = async (credentialPath?: string): Promise<CloudClient> => {
  const credentials = await readCloudCredentials(credentialPath);
  return createCloudClient({ baseUrl: credentials.baseUrl, accessToken: credentials.accessToken });
};

/** Revokes the server session before removing the local token. */
const logoutCloud = async (credentialPath?: string): Promise<{ authenticated: false }> => {
  const credentials = await readCloudCredentials(credentialPath, { allowExpired: true });
  const client = createCloudClient({
    baseUrl: credentials.baseUrl,
    accessToken: credentials.accessToken,
  });
  try {
    await client.request('DELETE', '/v1/auth/session');
  } catch (error) {
    if (!(error instanceof LocalError) || error.code !== 'cloud_auth_required') throw error;
  }
  await removeCloudCredentials(credentialPath);
  return { authenticated: false };
};

const projectSchema = z.object({ id: z.string(), name: z.string(), created_at: z.string() });
const runSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  revision_id: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  cancel_requested: z.boolean(),
  raw_expires_at: z.string().nullable(),
  error_code: z.string().nullable(),
});
const runResponseSchema = z.object({ run: runSchema });

const cloudProjectPath = (projectId: string): string =>
  `/v1/projects/${encodeURIComponent(projectId)}`;

/** Submits the existing eval request against an immutable uploaded revision. */
const runCloud = async (options: {
  client: CloudClient;
  projectId: string;
  revisionId: string;
  request: EvalRunRequest;
  idempotencyKey: string;
}): Promise<z.infer<typeof runResponseSchema>> =>
  parseCloudResponse(
    runResponseSchema,
    await options.client.request(
      'POST',
      `${cloudProjectPath(options.projectId)}/runs`,
      parseCloudInput(cloudRunRequestSchema, {
        revision_id: options.revisionId,
        request: options.request,
        idempotency_key: options.idempotencyKey,
      }),
    ),
  );

/** Reads persisted event pages after the caller's cursor; reconnecting never resubmits a run. */
const cloudEvents = async (options: {
  client: CloudClient;
  projectId: string;
  runId: string;
  after?: number;
  signal?: AbortSignal;
}): Promise<CloudEventPage> => {
  const after = options.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0)
    throw new LocalError('cli_usage', 'Event cursor must be a non-negative integer.');
  const page = parseCloudResponse(
    eventPageSchema,
    await options.client.request(
      'GET',
      `${cloudProjectPath(options.projectId)}/runs/${encodeURIComponent(options.runId)}/events?after=${after}`,
      undefined,
      options.signal,
    ),
  );
  if (
    page.next_cursor < after ||
    page.events.some(
      (event, index) =>
        event.sequence <= (index === 0 ? after : page.events[index - 1]!.sequence) ||
        event.sequence > page.next_cursor,
    )
  )
    throw new LocalError('cloud_request_failed', 'Cloud event page has an invalid cursor order.');
  return page;
};

/** Lists the current account's cloud projects. */
const listCloudProjects = async (client: CloudClient) =>
  parseCloudResponse(
    z.object({ projects: z.array(projectSchema) }),
    await client.request('GET', '/v1/projects'),
  );

/** Creates an account-owned project without changing the local link. */
const createCloudProject = async (client: CloudClient, name: string) =>
  parseCloudResponse(
    z.object({ project: projectSchema }),
    await client.request('POST', '/v1/projects', {
      name: parseCloudInput(z.string().min(1).max(128), name),
    }),
  );

/** Reads the authoritative lifecycle state of a previously submitted run. */
const getCloudRun = async (client: CloudClient, projectId: string, runId: string) =>
  parseCloudResponse(
    runResponseSchema,
    await client.request('GET', `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}`),
  );

/** Requests cancellation of the existing run without replaying agent work. */
const cancelCloudRun = async (client: CloudClient, projectId: string, runId: string) =>
  parseCloudResponse(
    runResponseSchema,
    await client.request(
      'POST',
      `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    ),
  );

/** Returns durable summary data and the server's raw-evidence expiration flag. */
const getCloudRunResult = async (client: CloudClient, projectId: string, runId: string) =>
  parseCloudResponse(
    z.object({ run: runSchema, summary: z.unknown(), raw: z.unknown(), raw_expired: z.boolean() }),
    await client.request(
      'GET',
      `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}/result`,
    ),
  );

export {
  listCloudProjects,
  createCloudProject,
  getCloudRun,
  cancelCloudRun,
  getCloudRunResult,
  loginCloud,
  logoutCloud,
  authenticatedCloudClient,
  cloudProjectPath,
  runCloud,
  cloudEvents,
  type LoginNotice,
  type CloudEventPage,
};
