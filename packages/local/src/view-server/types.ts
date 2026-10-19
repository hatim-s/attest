import type { ProjectCatalog } from '@attest/core';

type CreateViewAppOptions = {
  allowedOrigin: () => string | undefined;
  indexHtml: string;
  catalog: ProjectCatalog;
};

type StartViewServerOptions = {
  indexHtml: string;
  port?: number;
  catalog: ProjectCatalog;
  /** Releases what the catalog opened; runs once, after the server stops accepting requests. */
  close: () => Promise<void>;
};

type ViewServerHandle = {
  close: () => Promise<void>;
  closed: Promise<void>;
  origin: string;
  url: string;
};

export { type CreateViewAppOptions, type StartViewServerOptions, type ViewServerHandle };
