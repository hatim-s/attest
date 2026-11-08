import type * as Effect from 'effect/Effect';
import type * as Exit from 'effect/Exit';
import type { ProjectCatalog, RunControl } from '@attest/core';
import type { ViewServerFailure } from './view-server-failure.js';

type CreateViewAppOptions = {
  allowedOrigin: () => string | undefined;
  indexHtml: string;
  catalog: ProjectCatalog;
  control?: RunControl;
};

type StartViewServerOptions = {
  indexHtml: string;
  port?: number;
  catalog: ProjectCatalog;
  /** Lets the dashboard start and cancel runs; without it the dashboard only reads. */
  control?: RunControl;
  /** Releases what the catalog opened; runs once, after the server stops accepting requests. */
  close: (primary: Exit.Exit<void, ViewServerFailure>) => Effect.Effect<void>;
};

type ViewServerHandle = {
  close: (primary?: Exit.Exit<void, ViewServerFailure>) => Effect.Effect<void, ViewServerFailure>;
  closed: Effect.Effect<void, ViewServerFailure>;
  origin: string;
  url: string;
};

export { type CreateViewAppOptions, type StartViewServerOptions, type ViewServerHandle };
