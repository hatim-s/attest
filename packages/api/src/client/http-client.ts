import * as Effect from 'effect/Effect';
import { parseWithSchema } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import type { PageQuery, RunStartRequest } from '@attest/core/records';
import type { ApiCapabilities } from '../contract/bootstrap.js';
import { apiErrorEnvelopeSchema } from '../contract/errors.js';
import { apiResponses } from '../contract/responses.js';
import { apiRoutes, buildPath } from '../contract/routes.js';
import type { ApiClient, RequestOptions } from './api-client.js';
import { ApiError } from './api-error.js';
import { observeRequest } from './request-observation.js';

/** One call to the API. Only starting a run posts a body. */
type ApiCall =
  | { method: 'GET'; query?: URLSearchParams; options?: RequestOptions }
  | { method: 'POST'; body?: RunStartRequest; options?: RequestOptions };

/** Serialises a flat query; absent fields are omitted so the server applies its defaults. */
const toSearch = (query: Readonly<Record<string, string | number | undefined>>): URLSearchParams =>
  new URLSearchParams(
    Object.entries(query).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, String(value)]],
    ),
  );

/** Picks the page fields; decoded queries also carry an open index signature. */
const pageSearch = ({ cursor, limit }: PageQuery) => toSearch({ cursor, limit });

const toRequestInit = (call: ApiCall): RequestInit => {
  const signal = call.options?.signal;

  if (call.method === 'GET') return { headers: { Accept: 'application/json' }, signal };

  if (call.body === undefined)
    return { method: 'POST', headers: { Accept: 'application/json' }, signal };

  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(call.body),
    signal,
  };
};

/** Parses every received body at the transport edge before exposing domain records. */
const createHttpClient = (
  baseUrl: string,
  capabilities: ApiCapabilities,
  fetchFn: typeof fetch,
): ApiClient => {
  const request = <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    path: string,
    call: ApiCall,
  ): Effect.Effect<S['Type'], Error> =>
    Effect.gen(function* () {
      const query = call.method === 'GET' ? call.query : undefined;
      const search = query === undefined || query.size === 0 ? '' : `?${query.toString()}`;

      const controller = new AbortController();

      const signal =
        call.options?.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, call.options.signal]);

      const response = yield* observeRequest(
        () => fetchFn(`${baseUrl}${path}${search}`, { ...toRequestInit(call), signal }),
        () => controller.abort(),
        (late) => late.body?.cancel() ?? Promise.resolve(),
      );

      const text = yield* observeRequest(
        () => response.text(),
        () => controller.abort(),
      );

      let body: unknown;

      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        const envelope = parseWithSchema(apiErrorEnvelopeSchema, body);

        return yield* Effect.fail(
          envelope.ok
            ? new ApiError(
                response.status,
                envelope.value.error.code,
                envelope.value.error.message,
                {
                  details: envelope.value.error.details,
                },
              )
            : new ApiError(
                response.status,
                'INVALID_RESPONSE',
                `Attest API request failed (${response.status}).`,
              ),
        );
      }

      const parsed = parseWithSchema(schema, body);

      if (!parsed.ok)
        return yield* Effect.fail(
          new ApiError(
            response.status,
            'INVALID_RESPONSE',
            parsed.error.issues
              .map(({ path, message }) => `${path.map(String).join('.')}: ${message}`)
              .join('; '),
          ),
        );

      return parsed.value;
    });

  return {
    mode: { kind: 'live' },
    capabilities,
    listOverviews: (options) =>
      request(apiResponses.listOverviews, apiRoutes.listOverviews.path, {
        method: apiRoutes.listOverviews.method,
        options,
      }),
    listProjects: (options) =>
      request(apiResponses.listProjects, apiRoutes.listProjects.path, {
        method: apiRoutes.listProjects.method,
        options,
      }),
    getProjectOverview: (params, options) =>
      request(
        apiResponses.getProjectOverview,
        buildPath(apiRoutes.getProjectOverview.path, params),
        { method: apiRoutes.getProjectOverview.method, options },
      ),
    listEvals: (params, query, options) =>
      request(apiResponses.listEvals, buildPath(apiRoutes.listEvals.path, params), {
        method: apiRoutes.listEvals.method,
        query: pageSearch(query),
        options,
      }),
    listEvalRuns: (params, { cursor, limit, since, until }, options) =>
      request(apiResponses.listEvalRuns, buildPath(apiRoutes.listEvalRuns.path, params), {
        method: apiRoutes.listEvalRuns.method,
        query: toSearch({ cursor, limit, since, until }),
        options,
      }),
    getEvalCaseWindow: (params, query, options) =>
      request(apiResponses.getEvalCaseWindow, buildPath(apiRoutes.getEvalCaseWindow.path, params), {
        method: apiRoutes.getEvalCaseWindow.method,
        query: pageSearch(query),
        options,
      }),
    getCaseHistory: (params, query, options) =>
      request(apiResponses.getCaseHistory, buildPath(apiRoutes.getCaseHistory.path, params), {
        method: apiRoutes.getCaseHistory.method,
        query: pageSearch(query),
        options,
      }),
    getActivity: (params, { from, to }, options) =>
      request(apiResponses.getActivity, buildPath(apiRoutes.getActivity.path, params), {
        method: apiRoutes.getActivity.method,
        query: toSearch({ from, to }),
        options,
      }),
    listRuns: (params, query, options) =>
      request(apiResponses.listRuns, buildPath(apiRoutes.listRuns.path, params), {
        method: apiRoutes.listRuns.method,
        query: pageSearch(query),
        options,
      }),
    getRun: (params, options) =>
      request(apiResponses.getRun, buildPath(apiRoutes.getRun.path, params), {
        method: apiRoutes.getRun.method,
        options,
      }),
    listCaseSummaries: (params, { cursor, limit, suiteName }, options) =>
      request(apiResponses.listCaseSummaries, buildPath(apiRoutes.listCaseSummaries.path, params), {
        method: apiRoutes.listCaseSummaries.method,
        query: toSearch({ cursor, limit, suiteName }),
        options,
      }),
    getCase: (params, options) =>
      request(apiResponses.getCase, buildPath(apiRoutes.getCase.path, params), {
        method: apiRoutes.getCase.method,
        options,
      }),
    listRunSuites: (params, options) =>
      request(apiResponses.listRunSuites, buildPath(apiRoutes.listRunSuites.path, params), {
        method: apiRoutes.listRunSuites.method,
        options,
      }),
    getDiff: (params, options) =>
      request(apiResponses.getDiff, buildPath(apiRoutes.getDiff.path, params), {
        method: apiRoutes.getDiff.method,
        options,
      }),
    listTests: (params, options) =>
      request(apiResponses.listTests, buildPath(apiRoutes.listTests.path, params), {
        method: apiRoutes.listTests.method,
        options,
      }),
    startRun: (params, body, options) =>
      request(apiResponses.startRun, buildPath(apiRoutes.startRun.path, params), {
        method: apiRoutes.startRun.method,
        body,
        options,
      }),
    cancelRun: (params, options) =>
      request(apiResponses.cancelRun, buildPath(apiRoutes.cancelRun.path, params), {
        method: apiRoutes.cancelRun.method,
        options,
      }),
  };
};

export { createHttpClient };
