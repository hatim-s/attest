import { inlineArtifactSchema, type InlineArtifact } from '@attest/contracts';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { listFiles } from './workspace-files.js';

// Keeps a base64-heavy completion under the executor's default 10 MiB response_bytes cap.
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

// The executor's default artifact_count.
const DEFAULT_MAX_COUNT = 64;

const MEDIA_TYPES = new Map([
  ['.cjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/jsonl'],
  ['.jsx', 'text/javascript'],
  ['.md', 'text/markdown'],
  ['.mjs', 'text/javascript'],
  ['.mts', 'text/typescript'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.svg', 'image/svg+xml'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.txt', 'text/plain'],
  ['.webp', 'image/webp'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
]);

type CollectArtifactsOptions = {
  /** Selects files by their root-relative path. Defaults to every file. */
  include?: (path: string) => boolean;
  /** Total raw bytes across collected files. Defaults to 4 MiB. */
  maxBytes?: number;
  /** Number of collected files. Defaults to 64. */
  maxCount?: number;
};

/**
 * Why a selected file was left out: its name is not a valid artifact path (for example a segment
 * over 255 characters), or it would exceed `maxCount` or `maxBytes`.
 */
type SkippedFile = { path: string; reason: 'invalid_path' | 'max_count' | 'max_bytes' };

type CollectedArtifacts = { artifacts: InlineArtifact[]; skipped: SkippedFile[] };

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Inlines bytes as text when they are valid UTF-8, else as base64. */
const toInlineArtifact = (path: string, bytes: Buffer): InlineArtifact => {
  const media_type = MEDIA_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream';

  try {
    return {
      kind: 'inline',
      path,
      media_type,
      encoding: 'utf8',
      content: strictUtf8.decode(bytes),
    };
  } catch {
    return {
      kind: 'inline',
      path,
      media_type,
      encoding: 'base64',
      content: bytes.toString('base64'),
    };
  }
};

/**
 * Reads files under `root` into inline artifacts with root-relative paths, in path order. Files
 * past the count or byte budget, and names the artifact path schema rejects, are reported in
 * `skipped` rather than failing the collection.
 */
const collectArtifacts = async (
  root: string,
  {
    include = () => true,
    maxBytes = DEFAULT_MAX_BYTES,
    maxCount = DEFAULT_MAX_COUNT,
  }: CollectArtifactsOptions = {},
): Promise<CollectedArtifacts> => {
  const artifacts: InlineArtifact[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;

  for (const path of await listFiles(root)) {
    if (!include(path)) continue;

    if (!inlineArtifactSchema.shape.path.safeParse(path).success) {
      skipped.push({ path, reason: 'invalid_path' });
      continue;
    }

    if (artifacts.length >= maxCount) {
      skipped.push({ path, reason: 'max_count' });
      continue;
    }

    const absolute = join(root, path);

    if (totalBytes + (await stat(absolute)).size > maxBytes) {
      skipped.push({ path, reason: 'max_bytes' });
      continue;
    }

    const bytes = await readFile(absolute);

    // The file may have grown between stat and read.
    if (totalBytes + bytes.length > maxBytes) {
      skipped.push({ path, reason: 'max_bytes' });
      continue;
    }

    totalBytes += bytes.length;
    artifacts.push(toInlineArtifact(path, bytes));
  }

  return { artifacts, skipped };
};

export {
  collectArtifacts,
  type CollectArtifactsOptions,
  type CollectedArtifacts,
  type SkippedFile,
};
