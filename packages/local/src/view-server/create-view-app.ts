import { createApiApp, createDashboardHtml } from '@attest/api';
import { API_ERROR_STATUS, type ApiErrorEnvelope } from '@attest/api/contract';
import { Hono } from 'hono';

import type { CreateViewAppOptions } from './types.js';

const forbidden: ApiErrorEnvelope = {
  error: { code: 'FORBIDDEN', message: 'Request origin is not allowed.' },
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Allows a request only from the dashboard itself. A browser names the page that sent a POST in
 * `Origin`, including a cross-site form, so a request that can start or cancel a run must carry
 * the server's own origin; any request naming another origin is refused.
 */
const isAllowedRequest = (request: Request, allowedOrigin: string | undefined): boolean => {
  // Loopback binding alone does not stop a browser using a rebound external hostname.
  if (allowedOrigin === undefined || new URL(request.url).origin !== allowedOrigin) return false;

  const origin = request.headers.get('Origin');

  if (origin === null) return SAFE_METHODS.has(request.method);

  return origin === allowedOrigin;
};

/** Composes the loopback dashboard host with host-owned origin policy. */
const createViewApp = (options: CreateViewAppOptions): Hono => {
  const dashboardHtml = createDashboardHtml(options.indexHtml, {
    kind: 'http',
    baseUrl: '/api',
    capabilities: { control: options.control !== undefined },
  });

  const app = new Hono();

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');

    if (!isAllowedRequest(context.req.raw, options.allowedOrigin())) {
      return context.json(forbidden, API_ERROR_STATUS.FORBIDDEN);
    }

    await next();
  });

  app.get('/', (context) => context.html(dashboardHtml));
  app.route('/api', createApiApp({ catalog: options.catalog, control: options.control }));

  return app;
};

export { createViewApp };
