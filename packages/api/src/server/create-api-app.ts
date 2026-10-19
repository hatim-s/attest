import {
  diffRuns,
  StoreError,
  type ProjectCatalog,
  type RunControl,
  type RunSource,
} from '@attest/core';
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
  runStartRequestSchema,
  suiteHistoryRequestSchema,
} from '../contract/requests.js';
import { parseInput, parseJsonBody, toErrorEnvelope } from './error-response.js';

import { readCaseSummaries } from './read-case-summaries.js';
import { readSuiteHistory } from './read-suite-history.js';

/** `control` is present only on hosts that can start and cancel runs, such as `attest view`. */
type ApiAppDeps = { catalog: ProjectCatalog; control?: RunControl };

type ProjectScope = { Variables: { source: RunSource } };

/**
 * Lets fetch hosts serve the same project and run reads without owning storage or host policy.
 * Run control is the host's injected implementation; without one those routes answer
 * CONTROL_UNAVAILABLE.
 */
const createApiApp = ({ catalog, control }: ApiAppDeps): Hono<ProjectScope> => {
  const app = new Hono<ProjectScope>();

  const requireControl = (): RunControl => {
    if (control === undefined) {
      throw new StoreError('CONTROL_UNAVAILABLE', 'This host cannot start or cancel runs.');
    }

    return control;
  };

  app.on(apiRoutes.listProjects.method, apiRoutes.listProjects.path, async (context) =>
    context.json({ items: await catalog.listProjects() }),
  );
  // Opens the project once per request; the catalog owns caching of opened sources.
  app.use(`${apiRoutes.listProjects.path}/:projectKey/*`, async (context, next) => {
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());
    context.set('source', await catalog.openProject(projectKey));
    await next();
  });

  app.on(apiRoutes.listRuns.method, apiRoutes.listRuns.path, async (context) =>
    context.json(
      await context.var.source.listRuns(parseInput(pageQuerySchema, context.req.query())),
    ),
  );
  app.on(apiRoutes.getRun.method, apiRoutes.getRun.path, async (context) =>
    context.json(
      await context.var.source.getRun(parseInput(runParamsSchema, context.req.param()).runId),
    ),
  );
  app.on(apiRoutes.listCaseSummaries.method, apiRoutes.listCaseSummaries.path, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());

    return context.json(
      await context.var.source.listCaseSummaries(
        runId,
        parseInput(pageQuerySchema, context.req.query()),
      ),
    );
  });
  app.on(apiRoutes.getCase.method, apiRoutes.getCase.path, async (context) => {
    const { runId, suiteName, caseId } = parseInput(caseParamsSchema, context.req.param());

    return context.json(await context.var.source.getCase(runId, suiteName, caseId));
  });
  app.on(apiRoutes.getDiff.method, apiRoutes.getDiff.path, async (context) => {
    const { baseRunId, candidateRunId } = parseInput(diffParamsSchema, context.req.param());

    return context.json(await diffRuns(context.var.source, baseRunId, candidateRunId));
  });
  app.on(apiRoutes.listRunSuites.method, apiRoutes.listRunSuites.path, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());

    return context.json({
      runId,
      suites: summarizeSuites(await readCaseSummaries(context.var.source, runId)),
    });
  });
  app.on(apiRoutes.getSuiteHistory.method, apiRoutes.getSuiteHistory.path, async (context) => {
    const { suiteName, limit } = parseInput(suiteHistoryRequestSchema, {
      ...context.req.query(),
      ...context.req.param(),
    });

    return context.json(await readSuiteHistory(context.var.source, suiteName, limit));
  });
  app.on(apiRoutes.listTests.method, apiRoutes.listTests.path, async (context) => {
    const runControl = requireControl();
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());

    return context.json({ items: await runControl.listTests(projectKey) });
  });
  app.on(apiRoutes.startRun.method, apiRoutes.startRun.path, async (context) => {
    const runControl = requireControl();
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());
    const request = await parseJsonBody(runStartRequestSchema, context.req.raw);

    return context.json(await runControl.startRun(projectKey, request), 201);
  });
  app.on(apiRoutes.cancelRun.method, apiRoutes.cancelRun.path, async (context) => {
    const runControl = requireControl();
    const { projectKey, runId } = parseInput(runParamsSchema, context.req.param());

    return context.json(await runControl.cancelRun(projectKey, runId));
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
