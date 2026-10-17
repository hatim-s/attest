import { z } from 'zod';
import type { PageQuery } from '@attest/core/records';
import { apiErrorEnvelopeSchema } from '../contract/errors.js';
import { apiResponses } from '../contract/responses.js';
import { apiRoutes, buildPath } from '../contract/routes.js';
import type { ApiClient, RequestOptions } from './api-client.js';
import { ApiError } from './api-error.js';

const toSearch = (query: PageQuery): URLSearchParams => {
  const search = new URLSearchParams();

  if (query.cursor !== undefined) search.set('cursor', query.cursor);

  if (query.limit !== undefined) search.set('limit', String(query.limit));

  return search;
};

/** Parses every received body at the transport edge before exposing domain records. */
const createHttpClient = (baseUrl: string, fetchFn: typeof fetch): ApiClient => {
  const request = async <Schema extends z.ZodType>(
    schema: Schema,
    path: string,
    query: URLSearchParams | undefined,
    options: RequestOptions | undefined,
  ): Promise<z.output<Schema>> => {
    const search = query === undefined || query.size === 0 ? '' : `?${query.toString()}`;

    const response = await fetchFn(`${baseUrl}${path}${search}`, {
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });

    const text = await response.text();
    let body: unknown;

    try {
      body = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }

    if (!response.ok) {
      const envelope = apiErrorEnvelopeSchema.safeParse(body);
      throw envelope.success
        ? new ApiError(response.status, envelope.data.error.code, envelope.data.error.message)
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
    listRuns: (query, options) =>
      request(apiResponses.listRuns, apiRoutes.listRuns, toSearch(query), options),
    getRun: (params, options) =>
      request(apiResponses.getRun, buildPath(apiRoutes.getRun, params), undefined, options),
    listCaseSummaries: (params, query, options) =>
      request(
        apiResponses.listCaseSummaries,
        buildPath(apiRoutes.listCaseSummaries, params),
        toSearch(query),
        options,
      ),
    getCase: (params, options) =>
      request(apiResponses.getCase, buildPath(apiRoutes.getCase, params), undefined, options),
    getDiff: (params, options) =>
      request(apiResponses.getDiff, buildPath(apiRoutes.getDiff, params), undefined, options),
  };
};

export { createHttpClient };
