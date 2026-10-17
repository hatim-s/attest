import { diffRuns, type RunSource } from '@attest/core';
import { Hono } from 'hono';

import { apiRoutes } from '../contract/routes.js';
import { API_ERROR_STATUS } from '../contract/errors.js';
import {
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  runParamsSchema,
} from '../contract/requests.js';
import { parseInput, toErrorEnvelope } from './error-response.js';

type ApiAppDeps = { source: RunSource };

/** Lets fetch hosts serve the same run reads without owning storage or host policy. */
const createApiApp = ({ source }: ApiAppDeps): Hono => {
  const app = new Hono();

  app.get(apiRoutes.listRuns, async (context) =>
    context.json(await source.listRuns(parseInput(pageQuerySchema, context.req.query()))),
  );
  app.get(apiRoutes.getRun, async (context) =>
    context.json(await source.getRun(parseInput(runParamsSchema, context.req.param()).runId)),
  );
  app.get(apiRoutes.listCaseSummaries, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());

    return context.json(
      await source.listCaseSummaries(runId, parseInput(pageQuerySchema, context.req.query())),
    );
  });
  app.get(apiRoutes.getCase, async (context) => {
    const { runId, suiteName, caseId } = parseInput(caseParamsSchema, context.req.param());

    return context.json(await source.getCase(runId, suiteName, caseId));
  });
  app.get(apiRoutes.getDiff, async (context) => {
    const { baseRunId, candidateRunId } = parseInput(diffParamsSchema, context.req.param());

    return context.json(await diffRuns(source, baseRunId, candidateRunId));
  });
  // Mounted Hono apps do not carry their notFound handler into the host.
  app.all('*', (context) =>
    context.json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' } }, 404),
  );
  app.onError((error, context) => {
    const body = toErrorEnvelope(error);

    return context.json(body, API_ERROR_STATUS[body.error.code]);
  });

  return app;
};

export { createApiApp, type ApiAppDeps };
