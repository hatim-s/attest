import type * as Effect from 'effect/Effect';
import type * as Exit from 'effect/Exit';
import type { ProjectCatalog, RunControl } from '@attest/core';

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
  close: (primary: Exit.Exit<void, Error>) => Effect.Effect<void, Error>;
};

type ViewServerHandle = {
  close: (primary?: Exit.Exit<void, Error>) => Effect.Effect<void, Error>;
  closed: Effect.Effect<void, Error>;
  origin: string;
  url: string;
};

export { type CreateViewAppOptions, type StartViewServerOptions, type ViewServerHandle };
