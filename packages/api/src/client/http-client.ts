import { z } from 'zod';
import type { PageQuery, RunStartRequest } from '@attest/core/records';
import type { ApiCapabilities } from '../contract/bootstrap.js';
import { apiErrorEnvelopeSchema } from '../contract/errors.js';
import { apiResponses } from '../contract/responses.js';
import { apiRoutes, buildPath } from '../contract/routes.js';
import type { ApiClient, RequestOptions } from './api-client.js';
import { ApiError } from './api-error.js';

/** One call to the API. Only starting a run posts a body. */
type ApiCall =
  | { method: 'GET'; query?: URLSearchParams; options?: RequestOptions }
  | { method: 'POST'; body?: RunStartRequest; options?: RequestOptions };

const toSearch = (query: PageQuery): URLSearchParams => {
  const search = new URLSearchParams();

  if (query.cursor !== undefined) search.set('cursor', query.cursor);

  if (query.limit !== undefined) search.set('limit', String(query.limit));

  return search;
};

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
  const request = async <Schema extends z.ZodType>(
    schema: Schema,
    path: string,
    call: ApiCall,
  ): Promise<z.output<Schema>> => {
    const query = call.method === 'GET' ? call.query : undefined;
    const search = query === undefined || query.size === 0 ? '' : `?${query.toString()}`;

    const response = await fetchFn(`${baseUrl}${path}${search}`, toRequestInit(call));

    const text = await response.text();
    let body: unknown;

    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const envelope = apiErrorEnvelopeSchema.safeParse(body);
      throw envelope.success
        ? new ApiError(response.status, envelope.data.error.code, envelope.data.error.message, {
            details: envelope.data.error.details,
          })
        : new ApiError(
            response.status,
            'INVALID_RESPONSE',
            `Attest API request failed (${response.status}).`,
          );
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success)
      throw new ApiError(response.status, 'INVALID_RESPONSE', z.prettifyError(parsed.error));

    return parsed.data;
  };

  return {
    mode: { kind: 'live' },
    capabilities,
    listProjects: (options) =>
      request(apiResponses.listProjects, apiRoutes.listProjects.path, {
        method: apiRoutes.listProjects.method,
        options,
      }),
    listRuns: (params, query, options) =>
      request(apiResponses.listRuns, buildPath(apiRoutes.listRuns.path, params), {
        method: apiRoutes.listRuns.method,
        query: toSearch(query),
        options,
      }),
    getRun: (params, options) =>
      request(apiResponses.getRun, buildPath(apiRoutes.getRun.path, params), {
        method: apiRoutes.getRun.method,
        options,
      }),
    listCaseSummaries: (params, query, options) =>
      request(apiResponses.listCaseSummaries, buildPath(apiRoutes.listCaseSummaries.path, params), {
        method: apiRoutes.listCaseSummaries.method,
        query: toSearch(query),
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
    getSuiteHistory: (params, query, options) =>
      request(apiResponses.getSuiteHistory, buildPath(apiRoutes.getSuiteHistory.path, params), {
        method: apiRoutes.getSuiteHistory.method,
        query: toSearch(query),
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
