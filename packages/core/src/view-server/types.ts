import type { Hono } from 'hono';

import type { AttestStore } from '../store/index.js';

type CreateViewAppOptions = {
  allowedOrigin: () => string | undefined;
  indexHtml?: string;
  onShutdown?: () => void;
  sessionToken: string;
  store: AttestStore;
};

type ViewApp = Hono;

type StartViewServerOptions = {
  indexHtml?: string;
  port?: number;
  sessionToken?: string;
  storePath: string;
};

type ViewServerHandle = {
  close: () => Promise<void>;
  closed: Promise<void>;
  origin: string;
  sessionToken: string;
  url: string;
};

export {
  type CreateViewAppOptions,
  type StartViewServerOptions,
  type ViewApp,
  type ViewServerHandle,
};
