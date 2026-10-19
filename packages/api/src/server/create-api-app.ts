import { diffRuns, type ProjectCatalog, type RunSource } from '@attest/core';
import { summarizeSuites } from '@attest/core/analytics';
import { Hono } from 'hono';

import { apiRoutes } from '../contract/routes.js';
import { API_ERROR_STATUS } from '../contract/errors.js';
import {
  caseParamsSchema,
  diffParamsSchema,
  pageQuerySchema,
  projectParamsSchema,
  runParamsSchema,
  suiteHistoryRequestSchema,
} from '../contract/requests.js';
import { parseInput, toErrorEnvelope } from './error-response.js';

import { readCaseSummaries } from './read-case-summaries.js';
import { readSuiteHistory } from './read-suite-history.js';

type ApiAppDeps = { catalog: ProjectCatalog };

type ProjectScope = { Variables: { source: RunSource } };

/** Lets fetch hosts serve the same project and run reads without owning storage or host policy. */
const createApiApp = ({ catalog }: ApiAppDeps): Hono<ProjectScope> => {
  const app = new Hono<ProjectScope>();

  app.get(apiRoutes.listProjects, async (context) =>
    context.json({ items: await catalog.listProjects() }),
  );
  // Opens the project once per request; the catalog owns caching of opened sources.
  app.use(`${apiRoutes.listProjects}/:projectKey/*`, async (context, next) => {
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());
    context.set('source', await catalog.openProject(projectKey));
    await next();
  });

  app.get(apiRoutes.listRuns, async (context) =>
    context.json(
      await context.var.source.listRuns(parseInput(pageQuerySchema, context.req.query())),
    ),
  );
  app.get(apiRoutes.getRun, async (context) =>
    context.json(
      await context.var.source.getRun(parseInput(runParamsSchema, context.req.param()).runId),
    ),
  );
  app.get(apiRoutes.listCaseSummaries, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());

    return context.json(
      await context.var.source.listCaseSummaries(
        runId,
        parseInput(pageQuerySchema, context.req.query()),
      ),
    );
  });
  app.get(apiRoutes.getCase, async (context) => {
    const { runId, suiteName, caseId } = parseInput(caseParamsSchema, context.req.param());

    return context.json(await context.var.source.getCase(runId, suiteName, caseId));
  });
  app.get(apiRoutes.getDiff, async (context) => {
    const { baseRunId, candidateRunId } = parseInput(diffParamsSchema, context.req.param());

    return context.json(await diffRuns(context.var.source, baseRunId, candidateRunId));
  });
  app.get(apiRoutes.listRunSuites, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());

    return context.json({
      runId,
      suites: summarizeSuites(await readCaseSummaries(context.var.source, runId)),
    });
  });
  app.get(apiRoutes.getSuiteHistory, async (context) => {
    const { suiteName, limit } = parseInput(suiteHistoryRequestSchema, {
      ...context.req.query(),
      ...context.req.param(),
    });

    return context.json(await readSuiteHistory(context.var.source, suiteName, limit));
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
