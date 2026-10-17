import { createHash, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

import { cloudRunRequestSchema, type EvalRunRequest } from '@attest/contracts';
import { z } from 'zod';

import { LocalError } from '../errors/local-error.js';
import { createCloudClient, type CloudClient } from './client.js';
import {
  readCloudCredentials,
  removeCloudCredentials,
  writeCloudCredentials,
} from './credentials.js';
import {
  CloudRemoteError,
  emptyResponseSchema,
  deviceSchema,
  tokenSchema,
  eventPageSchema,
  runResponseSchema,
  projectsResponseSchema,
  projectResponseSchema,
  runResultSchema,
  type LoginNotice,
  type CloudEventPage,
} from './protocol.js';

/** Rejects malformed caller input before opening a network request. */
// BOUNDARY: Cloud command inputs are validated by the supplied Zod schema before network submission.
const parseCloudInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success)
    throw new LocalError('cli_usage', 'Cloud request does not match the protocol.');

  return parsed.data;
};

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

  const device = await client.request('POST', '/v1/auth/device', {
    schema: deviceSchema,
    body: { code_challenge: createHash('sha256').update(verifier).digest('base64url') },
    signal: options.signal,
  });

  if (new URL(device.verification_uri).origin !== client.baseUrl)
    throw new LocalError('cloud_request_failed', 'Cloud approval URL points to another origin.');
  options.onDevice({
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    expires_in: device.expires_in,
  });
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new LocalError('cancelled', 'Cloud login cancelled.');

    try {
      const token = await client.request('POST', '/v1/auth/device/token', {
        schema: tokenSchema,
        body: { device_code: device.device_code, code_verifier: verifier },
        signal: options.signal,
      });

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
      if (!(error instanceof CloudRemoteError) || error.outcome.kind !== 'device') throw error;

      if (error.outcome.code === 'slow_down') interval += 5_000;
      else if (error.outcome.code !== 'authorization_pending') throw error;
    }

    try {
      await setTimeout(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, {
        signal: options.signal,
      });
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
    await client.request('DELETE', '/v1/auth/session', { schema: emptyResponseSchema });
  } catch (error) {
    if (!(error instanceof LocalError) || error.code !== 'cloud_auth_required') throw error;
  }

  await removeCloudCredentials(credentialPath);

  return { authenticated: false };
};

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
  await options.client.request('POST', `${cloudProjectPath(options.projectId)}/runs`, {
    schema: runResponseSchema,
    body: parseCloudInput(cloudRunRequestSchema, {
      revision_id: options.revisionId,
      request: options.request,
      idempotency_key: options.idempotencyKey,
    }),
  });

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

  const page = await options.client.request(
    'GET',
    `${cloudProjectPath(options.projectId)}/runs/${encodeURIComponent(options.runId)}/events?after=${after}`,
    { schema: eventPageSchema, body: undefined, signal: options.signal },
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
  await client.request('GET', '/v1/projects', { schema: projectsResponseSchema });

/** Creates an account-owned project without changing the local link. */
const createCloudProject = async (client: CloudClient, name: string) =>
  await client.request('POST', '/v1/projects', {
    schema: projectResponseSchema,
    body: {
      name: parseCloudInput(z.string().min(1).max(128), name),
    },
  });

/** Reads the authoritative lifecycle state of a previously submitted run. */
const getCloudRun = async (client: CloudClient, projectId: string, runId: string) =>
  await client.request('GET', `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}`, {
    schema: runResponseSchema,
  });

/** Requests cancellation of the existing run without replaying agent work. */
const cancelCloudRun = async (client: CloudClient, projectId: string, runId: string) =>
  await client.request(
    'POST',
    `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { schema: runResponseSchema },
  );

/** Returns durable summary data and the server's raw-evidence expiration flag. */
const getCloudRunResult = async (client: CloudClient, projectId: string, runId: string) =>
  await client.request(
    'GET',
    `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}/result`,
    { schema: runResultSchema },
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
