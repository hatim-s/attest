import { describe, expect, it } from 'vitest';

import { collectBoundedImportSource } from '../tabular-import-adapter.js';

describe('collectBoundedImportSource', () => {
  it('stops reading before consuming bytes beyond the hard cap', async () => {
    let consumedPastLimit = false;
    const chunks = async function* sourceChunks(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
      consumedPastLimit = true;
      yield new Uint8Array([5]);
    };

    await expect(collectBoundedImportSource(chunks(), 3)).rejects.toMatchObject({
      diagnostics: [{ code: 'import_size_limit' }],
    });
    expect(consumedPastLimit).toBe(false);
  });
});
