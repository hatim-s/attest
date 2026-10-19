import { createApiApp, createDashboardHtml } from '@attest/api';
import { API_ERROR_STATUS, type ApiErrorEnvelope } from '@attest/api/contract';
import { Hono } from 'hono';

import type { CreateViewAppOptions } from './types.js';

const forbidden: ApiErrorEnvelope = {
  error: { code: 'FORBIDDEN', message: 'Request origin is not allowed.' },
};

/** Composes the loopback dashboard host with host-owned origin policy. */
const createViewApp = (options: CreateViewAppOptions): Hono => {
  const dashboardHtml = createDashboardHtml(options.indexHtml, { kind: 'http', baseUrl: '/api' });
  const app = new Hono();

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    // Loopback binding alone does not stop a browser using a rebound external hostname.
    const allowedOrigin = options.allowedOrigin();

    if (allowedOrigin === undefined || new URL(context.req.url).origin !== allowedOrigin) {
      return context.json(forbidden, API_ERROR_STATUS.FORBIDDEN);
    }

    await next();
  });

  app.get('/', (context) => context.html(dashboardHtml));
  app.route('/api', createApiApp({ catalog: options.catalog }));

  return app;
};

export { createViewApp };
