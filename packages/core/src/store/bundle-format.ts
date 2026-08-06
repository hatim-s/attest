import { createHash } from 'node:crypto';

import { canonicalStringify } from './internal/canonical-json.js';
import type { CaseRecord, RunRecord } from './types.js';

const BUNDLE_VERSION = 'attest.bundle/v1alpha1';

/** Describes the run metadata line that starts every PLAN 1S.4 cloud-ingest bundle. */
interface BundleHeader {
  type: 'bundle_header';
  bundle_version: typeof BUNDLE_VERSION;
  run: RunRecord;
}

/** Describes one case and its embedded metric evidence in a run bundle. */
interface BundleCase {
  type: 'case';
  case: CaseRecord;
}

/** Describes the verified content identity that ends every run bundle. */
interface BundleFooter {
  type: 'bundle_footer';
  case_count: number;
  content_hash: string;
}

type BundleLine = BundleHeader | BundleCase | BundleFooter;

/** Summarizes a completed PLAN 1S.4 export for future cloud-ingest callers. */
interface BundleManifest {
  bundleVersion: typeof BUNDLE_VERSION;
  runId: string;
  caseCount: number;
  contentHash: string;
}

/** Incrementally hashes canonical NDJSON lines without including a trailing newline. */
const createContentHasher = (): { add(line: string): void; digest(): string } => {
  const hash = createHash('sha256');
  let hasLine = false;
  return {
    add(line) {
      if (hasLine) hash.update('\n');
      hash.update(line);
      hasLine = true;
    },
    digest: () => hash.digest('hex'),
  };
};

/** Purely assembles canonical bundle lines from one already-loaded run aggregate. */
const createBundle = (
  run: RunRecord,
  cases: CaseRecord[],
): { lines: string[]; manifest: BundleManifest } => {
  const hasher = createContentHasher();
  const headerLine = canonicalStringify({
    type: 'bundle_header',
    bundle_version: BUNDLE_VERSION,
    run,
  });
  const lines = [headerLine];
  hasher.add(headerLine);

  for (const caseRecord of cases) {
    const line = canonicalStringify({ type: 'case', case: caseRecord });
    lines.push(line);
    hasher.add(line);
  }

  const contentHash = hasher.digest();
  lines.push(
    canonicalStringify({
      type: 'bundle_footer',
      case_count: cases.length,
      content_hash: contentHash,
    }),
  );
  return {
    lines,
    manifest: {
      bundleVersion: BUNDLE_VERSION,
      runId: run.id,
      caseCount: cases.length,
      contentHash,
    },
  };
};

export {
  BUNDLE_VERSION,
  createBundle,
  createContentHasher,
  type BundleCase,
  type BundleFooter,
  type BundleHeader,
  type BundleLine,
  type BundleManifest,
};
