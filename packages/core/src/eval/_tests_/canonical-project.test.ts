import { describe, expect, it } from 'vitest';

import { contentHash } from '../../store/internal/canonical-json.js';
import {
  hashDatasetMetadata,
  hashCanonicalJsonLines,
  serializeCanonicalJsonLines,
} from '../canonical-project.js';

describe('canonical project content', () => {
  it('uses one stable JSONL separator and excludes a trailing newline', () => {
    const records = [
      { input: { question: 'one' }, id: 'one' },
      { id: 'two', input: { question: 'two' } },
    ];

    expect(serializeCanonicalJsonLines(records)).toBe(
      '{"id":"one","input":{"question":"one"}}\n{"id":"two","input":{"question":"two"}}',
    );
    expect(hashCanonicalJsonLines(records)).toHaveLength(64);
  });

  it('excludes only truthful import time from dataset metadata reproducibility hashes', () => {
    const first = {
      id: 'cases',
      provenance: {
        imported_at: '2026-08-08T01:00:00.000Z',
        source_content_hash: 'a'.repeat(64),
      },
    };

    const second = {
      ...first,
      provenance: { ...first.provenance, imported_at: '2026-08-08T02:00:00.000Z' },
    };

    expect(hashDatasetMetadata(first)).toBe(hashDatasetMetadata(second));
    expect(contentHash(first)).not.toBe(contentHash(second));
    expect(
      hashDatasetMetadata({
        ...second,
        provenance: { ...second.provenance, source_content_hash: 'b'.repeat(64) },
      }),
    ).not.toBe(hashDatasetMetadata(first));
  });
});
