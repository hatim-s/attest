import type { RunSource } from '@attest/core';

type CreateViewAppOptions = {
  allowedOrigin: () => string | undefined;
  indexHtml: string;
  source: RunSource;
};

type StartViewServerOptions = {
  indexHtml: string;
  port?: number;
  storePath: string;
};

type ViewServerHandle = {
  close: () => Promise<void>;
  closed: Promise<void>;
  origin: string;
  url: string;
};

export { type CreateViewAppOptions, type StartViewServerOptions, type ViewServerHandle };
