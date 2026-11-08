import {
  diffRuns,
  StoreError,
  type ProjectCatalog,
  type RunControl,
  type RunSource,
} from '@attest/core';
import * as Effect from 'effect/Effect';
import { Hono } from 'hono';

import { apiRoutes } from '../contract/routes.js';
import { API_ERROR_STATUS } from '../contract/errors.js';
import {
  activityQuerySchema,
  caseHistoryParamsSchema,
  caseParamsSchema,
  caseSummariesQuerySchema,
  diffParamsSchema,
  evalParamsSchema,
  evalRunsQuerySchema,
  pageQuerySchema,
  projectParamsSchema,
  runParamsSchema,
  runStartRequestSchema,
} from '../contract/requests.js';
import { parseInput, parseJsonBody, toErrorEnvelope, readExitValue } from './error-response.js';
import { readOverviews } from './read-overviews.js';

/** `control` is present only on hosts that can start and cancel runs, such as `attest web`. */
type ApiAppDeps = { catalog: ProjectCatalog; control?: RunControl };

type ProjectScope = { Variables: { source: RunSource } };

/** Runs one store read under the request's abort signal and unwraps it into a value or a throw. */
const read = async <A>(context: { req: { raw: Request } }, effect: Effect.Effect<A, StoreError>) =>
  readExitValue(await Effect.runPromiseExit(effect, { signal: context.req.raw.signal }));

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

  app.on(apiRoutes.listOverviews.method, apiRoutes.listOverviews.path, async (context) =>
    context.json({ items: await read(context, readOverviews(catalog)) }),
  );
  app.on(apiRoutes.listProjects.method, apiRoutes.listProjects.path, async (context) =>
    context.json({ items: await read(context, catalog.listProjects()) }),
  );
  // Opens the project once per request; the catalog owns caching of opened sources.
  app.use(`${apiRoutes.listProjects.path}/:projectKey/*`, async (context, next) => {
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());
    context.set('source', await read(context, catalog.openProject(projectKey)));
    await next();
  });

  app.on(apiRoutes.getProjectOverview.method, apiRoutes.getProjectOverview.path, async (context) =>
    context.json(await read(context, context.var.source.getProjectOverview())),
  );
  app.on(apiRoutes.listEvals.method, apiRoutes.listEvals.path, async (context) =>
    context.json(
      await read(
        context,
        context.var.source.listEvals(parseInput(pageQuerySchema, context.req.query())),
      ),
    ),
  );
  app.on(apiRoutes.listEvalRuns.method, apiRoutes.listEvalRuns.path, async (context) => {
    const { suiteName } = parseInput(evalParamsSchema, context.req.param());
    const query = parseInput(evalRunsQuerySchema, context.req.query());

    return context.json(await read(context, context.var.source.listEvalRuns(suiteName, query)));
  });
  app.on(apiRoutes.getEvalCaseWindow.method, apiRoutes.getEvalCaseWindow.path, async (context) => {
    const { suiteName } = parseInput(evalParamsSchema, context.req.param());
    const query = parseInput(pageQuerySchema, context.req.query());

    return context.json(
      await read(context, context.var.source.getEvalCaseWindow(suiteName, query)),
    );
  });
  app.on(apiRoutes.getCaseHistory.method, apiRoutes.getCaseHistory.path, async (context) => {
    const { suiteName, caseId } = parseInput(caseHistoryParamsSchema, context.req.param());
    const query = parseInput(pageQuerySchema, context.req.query());

    return context.json(
      await read(context, context.var.source.getCaseHistory(suiteName, caseId, query)),
    );
  });
  app.on(apiRoutes.getActivity.method, apiRoutes.getActivity.path, async (context) =>
    context.json(
      await read(
        context,
        context.var.source.getActivity(parseInput(activityQuerySchema, context.req.query())),
      ),
    ),
  );

  app.on(apiRoutes.listRuns.method, apiRoutes.listRuns.path, async (context) =>
    context.json(
      await read(
        context,
        context.var.source.listRuns(parseInput(pageQuerySchema, context.req.query())),
      ),
    ),
  );
  app.on(apiRoutes.getRun.method, apiRoutes.getRun.path, async (context) =>
    context.json(
      await read(
        context,
        context.var.source.getRun(parseInput(runParamsSchema, context.req.param()).runId),
      ),
    ),
  );
  app.on(apiRoutes.listCaseSummaries.method, apiRoutes.listCaseSummaries.path, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());
    const query = parseInput(caseSummariesQuerySchema, context.req.query());

    return context.json(await read(context, context.var.source.listCaseSummaries(runId, query)));
  });
  app.on(apiRoutes.getCase.method, apiRoutes.getCase.path, async (context) => {
    const { runId, suiteName, caseId } = parseInput(caseParamsSchema, context.req.param());

    return context.json(await read(context, context.var.source.getCase(runId, suiteName, caseId)));
  });
  app.on(apiRoutes.getDiff.method, apiRoutes.getDiff.path, async (context) => {
    const { baseRunId, candidateRunId } = parseInput(diffParamsSchema, context.req.param());

    return context.json(
      await read(context, diffRuns(context.var.source, baseRunId, candidateRunId)),
    );
  });
  app.on(apiRoutes.listRunSuites.method, apiRoutes.listRunSuites.path, async (context) => {
    const { runId } = parseInput(runParamsSchema, context.req.param());

    return context.json({
      runId,
      suites: await read(context, context.var.source.listRunSuites(runId)),
    });
  });
  app.on(apiRoutes.listTests.method, apiRoutes.listTests.path, async (context) => {
    const runControl = requireControl();
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());

    return context.json({ items: await read(context, runControl.listTests(projectKey)) });
  });
  app.on(apiRoutes.startRun.method, apiRoutes.startRun.path, async (context) => {
    const runControl = requireControl();
    const { projectKey } = parseInput(projectParamsSchema, context.req.param());
    const request = await parseJsonBody(runStartRequestSchema, context.req.raw);

    // Not tied to the request signal: a started run must finish recording even if the client leaves.
    return context.json(
      readExitValue(await Effect.runPromiseExit(runControl.startRun(projectKey, request))),
      201,
    );
  });
  app.on(apiRoutes.cancelRun.method, apiRoutes.cancelRun.path, async (context) => {
    const runControl = requireControl();
    const { projectKey, runId } = parseInput(runParamsSchema, context.req.param());

    return context.json(await read(context, runControl.cancelRun(projectKey, runId)));
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
