import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { diffRuns } from '../diff/index.js';
import { StoreError } from '../store/index.js';
import type { CreateViewAppOptions, ViewApp } from './types.js';

const API_SCHEMA_ID = 'attest.view';
const DEFAULT_INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attest</title></head><body><main><h1>Attest</h1><p>The dashboard bundle is not installed.</p></main></body></html>`;

const parseLimit = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000) {
    throw new StoreError('INVALID_LIMIT', 'limit must be an integer from 1 to 1000.');
  }
  return parsed;
};

const tokenMatches = (presented: string | undefined, expected: string): boolean => {
  if (presented === undefined || !presented.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(presented.slice('Bearer '.length));
  const expectedBuffer = Buffer.from(expected);
  return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
};

/** Creates the loopback dashboard interface without owning sockets or the SQLite lifecycle. */
const createViewApp = (options: CreateViewAppOptions): ViewApp => {
  const app = new Hono();

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    // Loopback binding alone does not stop a browser using a rebound external hostname.
    const allowedOrigin = options.allowedOrigin();
    if (allowedOrigin === undefined || new URL(context.req.url).origin !== allowedOrigin) {
      return context.json(
        { error: { code: 'origin_forbidden', message: 'Request origin is not allowed.' } },
        403,
      );
    }
    await next();
  });

  app.use('/api/*', async (context, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)) {
      await next();
      return;
    }

    const allowedOrigin = options.allowedOrigin();
    if (allowedOrigin === undefined || context.req.header('Origin') !== allowedOrigin) {
      return context.json(
        { error: { code: 'origin_forbidden', message: 'Write origin is not allowed.' } },
        403,
      );
    }
    if (!tokenMatches(context.req.header('Authorization'), options.sessionToken)) {
      return context.json(
        { error: { code: 'unauthorized', message: 'A valid view session token is required.' } },
        401,
      );
    }

    await next();
  });

  app.get('/', (context) => context.html(options.indexHtml ?? DEFAULT_INDEX_HTML));
  app.get('/api/health', (context) => context.json({ schema: API_SCHEMA_ID, ok: true }));
  app.get('/api/runs', async (context) => {
    const runs = await options.store.runs.listRuns({
      limit: parseLimit(context.req.query('limit')),
    });
    return context.json({ schema: API_SCHEMA_ID, runs });
  });
  app.get('/api/runs/:runId', async (context) => {
    const run = await options.store.runs.getRun(context.req.param('runId'));
    return context.json({ schema: API_SCHEMA_ID, run });
  });
  app.get('/api/runs/:runId/cases', async (context) => {
    const page = await options.store.runs.listCaseSummaries(context.req.param('runId'), {
      cursor: context.req.query('cursor'),
      limit: parseLimit(context.req.query('limit')),
    });
    return context.json({ schema: API_SCHEMA_ID, ...page });
  });
  app.get('/api/runs/:runId/cases/:suiteName/:caseId', async (context) => {
    const caseRecord = await options.store.runs.getCase(
      context.req.param('runId'),
      context.req.param('suiteName'),
      context.req.param('caseId'),
    );
    return context.json({ schema: API_SCHEMA_ID, case: caseRecord });
  });
  app.get('/api/diffs/:baseRunId/:candidateRunId', async (context) => {
    const diff = await diffRuns(
      options.store.runs,
      context.req.param('baseRunId'),
      context.req.param('candidateRunId'),
    );
    return context.json({ schema: API_SCHEMA_ID, diff });
  });
  app.post('/api/shutdown', (context) => {
    options.onShutdown?.();
    return context.body(null, 204);
  });

  app.notFound((context) =>
    context.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404),
  );
  app.onError((error, context) => {
    if (error instanceof StoreError) {
      const status = ['RUN_NOT_FOUND', 'CASE_NOT_FOUND'].includes(error.code) ? 404 : 400;
      return context.json({ error: { code: error.code, message: error.message } }, status);
    }
    return context.json(
      {
        error: {
          code: 'internal_error',
          message: 'The view server could not complete the request.',
        },
      },
      500,
    );
  });

  return app;
};

export { API_SCHEMA_ID, createViewApp };
