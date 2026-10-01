import { describe, expect, it } from 'vitest';

import {
  hashDatasetMetadata,
  hashCanonicalJson,
  hashCanonicalJsonLines,
  serializeCanonicalJson,
  serializeCanonicalJsonLines,
} from '../canonical-project.js';

describe('canonical project content', () => {
  it('sorts object keys recursively without reordering arrays', () => {
    expect(serializeCanonicalJson({ zeta: { beta: 2, alpha: 1 }, alpha: [{ z: 2, a: 1 }] })).toBe(
      '{"alpha":[{"a":1,"z":2}],"zeta":{"alpha":1,"beta":2}}',
    );
  });

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

  it('produces stable hashes for equivalent object key orderings', () => {
    expect(hashCanonicalJson({ zeta: 2, alpha: 1 })).toBe(hashCanonicalJson({ alpha: 1, zeta: 2 }));
    expect(hashCanonicalJson({ alpha: 1 })).not.toBe(hashCanonicalJson({ alpha: 2 }));
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
    expect(hashCanonicalJson(first)).not.toBe(hashCanonicalJson(second));
    expect(
      hashDatasetMetadata({
        ...second,
        provenance: { ...second.provenance, source_content_hash: 'b'.repeat(64) },
      }),
    ).not.toBe(hashDatasetMetadata(first));
  });
});
