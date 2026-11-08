import { withOperationCleanup } from '../internal/operation-cleanup.js';
import * as Effect from 'effect/Effect';
import { createHash, randomBytes } from 'node:crypto';

import {
  parseWithSchemaEffect,
  cloudRunRequestSchema,
  type EvalRunRequest,
} from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { LocalError } from '../errors/local-error.js';
import { createCloudClient, type CloudClient } from './client.js';
import {
  readCloudCredentials,
  resolveCloudCredentials,
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
// BOUNDARY: Cloud command inputs are validated by the supplied native schema before network submission.
const parseCloudInput = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) =>
  parseWithSchemaEffect(schema, value).pipe(
    Effect.mapError(
      () => new LocalError('cli_usage', 'Cloud request does not match the protocol.'),
    ),
  );

/** Races only the polling delay against business cancellation, retaining listener release. */
const waitForCloudPoll = Effect.fn('waitForCloudPoll')(function* (
  milliseconds: number,
  signal?: AbortSignal,
) {
  if (signal === undefined) return yield* Effect.sleep(milliseconds);
  let cancel: (() => void) | undefined;

  return yield* withOperationCleanup(
    Effect.raceFirst(
      Effect.sleep(milliseconds),
      Effect.callback<void, LocalError>((resume) => {
        cancel = () => resume(Effect.fail(new LocalError('cancelled', 'Cloud login cancelled.')));
        signal.addEventListener('abort', cancel, { once: true });

        if (signal.aborted) cancel();
      }),
    ),
    Effect.sync(() => {
      if (cancel !== undefined) signal.removeEventListener('abort', cancel);
    }),
  );
});

/** Exchanges a user-approved PKCE device session for a private, revocable CLI token. */
const loginCloud = Effect.fn('loginCloud')(function* (options: {
  baseUrl: string;
  credentialPath: string;
  signal?: AbortSignal;
  onDevice: (notice: LoginNotice) => void;
  fetch?: typeof fetch;
}) {
  const client = yield* createCloudClient({ baseUrl: options.baseUrl, fetch: options.fetch });

  const verifier = randomBytes(32).toString('base64url');

  const device = yield* client.request('POST', '/v1/auth/device', {
    schema: deviceSchema,
    body: { code_challenge: createHash('sha256').update(verifier).digest('base64url') },
    signal: options.signal,
  });

  if (new URL(device.verification_uri).origin !== client.baseUrl)
    return yield* new LocalError(
      'cloud_request_failed',
      'Cloud approval URL points to another origin.',
    );
  options.onDevice({
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    expires_in: device.expires_in,
  });
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;

  while (Date.now() < deadline) {
    if (options.signal?.aborted)
      return yield* new LocalError('cancelled', 'Cloud login cancelled.');

    const loggedIn = yield* Effect.gen(function* () {
      const token = yield* client.request('POST', '/v1/auth/device/token', {
        schema: tokenSchema,
        body: { device_code: device.device_code, code_verifier: verifier },
        signal: options.signal,
      });

      yield* writeCloudCredentials(
        {
          baseUrl: client.baseUrl,
          accessToken: token.access_token,
          expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        },
        options.credentialPath,
      );

      return { base_url: client.baseUrl, authenticated: true as const };
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!(error instanceof CloudRemoteError) || error.outcome.kind !== 'device')
            return yield* error;

          if (error.outcome.code === 'slow_down') interval += 5000;
          else if (error.outcome.code === 'expired_token') {
            return yield* new LocalError(
              'cloud_auth_required',
              'Cloud approval code expired. Run attest cloud login again.',
            );
          } else if (error.outcome.code === 'access_denied') {
            return yield* new LocalError(
              'cloud_auth_required',
              'Cloud login was denied. Run attest cloud login again.',
            );
          }
        }),
      ),
    );

    if (loggedIn !== undefined) return loggedIn;
    yield* waitForCloudPoll(Math.min(interval, Math.max(0, deadline - Date.now())), options.signal);
  }

  return yield* new LocalError(
    'cloud_auth_required',
    'Cloud approval code expired. Run attest cloud login again.',
  );
});

/** Loads only credentials tied to the configured cloud origin. */
const authenticatedCloudClient = Effect.fn('authenticatedCloudClient')(function* (
  credentialPath: string,
) {
  const credentials = yield* resolveCloudCredentials(credentialPath);

  return yield* createCloudClient(credentials);
});

/** Revokes the server session before removing the local token. */
const logoutCloud = Effect.fn('logoutCloud')(function* (credentialPath: string) {
  const credentials = yield* readCloudCredentials(credentialPath, { allowExpired: true });

  const client = yield* createCloudClient({
    baseUrl: credentials.baseUrl,
    accessToken: credentials.accessToken,
  });

  yield* Effect.gen(function* () {
    yield* client.request('DELETE', '/v1/auth/session', { schema: emptyResponseSchema });
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (!(error instanceof LocalError) || error.code !== 'cloud_auth_required')
          return yield* error;
      }),
    ),
  );
  yield* removeCloudCredentials(credentialPath);

  return { authenticated: false };
});

const cloudProjectPath = (projectId: string): string =>
  `/v1/projects/${encodeURIComponent(projectId)}`;

/** Submits the existing eval request against an immutable uploaded revision. */
const runCloud = Effect.fn('runCloud')(function* (options: {
  client: CloudClient;
  projectId: string;
  revisionId: string;
  request: EvalRunRequest;
  idempotencyKey: string;
}) {
  return yield* options.client.request('POST', `${cloudProjectPath(options.projectId)}/runs`, {
    schema: runResponseSchema,
    body: yield* parseCloudInput(cloudRunRequestSchema, {
      revision_id: options.revisionId,
      request: options.request,
      idempotency_key: options.idempotencyKey,
    }),
  });
});

/** Reads persisted event pages after the caller's cursor; reconnecting never resubmits a run. */
const cloudEvents = Effect.fn('cloudEvents')(function* (options: {
  client: CloudClient;
  projectId: string;
  runId: string;
  after?: number;
  signal?: AbortSignal;
}) {
  const after = options.after ?? 0;

  if (!Number.isSafeInteger(after) || after < 0)
    return yield* new LocalError('cli_usage', 'Event cursor must be a non-negative integer.');

  const page = yield* options.client.request(
    'GET',
    `${cloudProjectPath(options.projectId)}/runs/${encodeURIComponent(options.runId)}/events?after=${after}`,
    { schema: eventPageSchema, signal: options.signal },
  );

  if (
    page.next_cursor < after ||
    page.events.some(
      (event, index) =>
        event.sequence <= (index === 0 ? after : page.events[index - 1]!.sequence) ||
        event.sequence > page.next_cursor,
    )
  )
    return yield* new LocalError(
      'cloud_request_failed',
      'Cloud event page has an invalid cursor order.',
    );

  return page;
});

/** Lists the current account's cloud projects. */
const listCloudProjects = Effect.fn('listCloudProjects')(function* (client: CloudClient) {
  return yield* client.request('GET', '/v1/projects', { schema: projectsResponseSchema });
});

/** Creates an account-owned project without changing the local link. */
const createCloudProject = Effect.fn('createCloudProject')(function* (
  client: CloudClient,
  name: string,
) {
  return yield* client.request('POST', '/v1/projects', {
    schema: projectResponseSchema,
    body: {
      name: yield* parseCloudInput(
        Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
        name,
      ),
    },
  });
});

/** Reads the authoritative lifecycle state of a previously submitted run. */
const getCloudRun = Effect.fn('getCloudRun')(function* (
  client: CloudClient,
  projectId: string,
  runId: string,
) {
  return yield* client.request(
    'GET',
    `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}`,
    {
      schema: runResponseSchema,
    },
  );
});

/** Requests cancellation of the existing run without replaying agent work. */
const cancelCloudRun = Effect.fn('cancelCloudRun')(function* (
  client: CloudClient,
  projectId: string,
  runId: string,
) {
  return yield* client.request(
    'POST',
    `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { schema: runResponseSchema },
  );
});

/** Returns durable summary data and the server's raw-evidence expiration flag. */
const getCloudRunResult = Effect.fn('getCloudRunResult')(function* (
  client: CloudClient,
  projectId: string,
  runId: string,
) {
  return yield* client.request(
    'GET',
    `${cloudProjectPath(projectId)}/runs/${encodeURIComponent(runId)}/result`,
    { schema: runResultSchema },
  );
});

export {
  listCloudProjects,
  createCloudProject,
  getCloudRun,
  cancelCloudRun,
  getCloudRunResult,
  loginCloud,
  logoutCloud,
  authenticatedCloudClient,
  runCloud,
  cloudEvents,
  type LoginNotice,
  type CloudEventPage,
};
