type LineFramer = {
  /** Returns the lines this chunk completed, or `undefined` once a line exceeds the limit. */
  push: (chunk: Buffer) => string[] | undefined;
};

/**
 * Splits a byte stream into records on LF only, stripping one trailing CR. Pi's framing is strict
 * JSONL: U+2028 and U+2029 are valid inside JSON strings, so Node's `readline`, which also splits
 * on them, would corrupt records. Bytes are buffered until LF so multi-byte characters split
 * across chunks decode intact.
 */
const createLineFramer = (maxLineBytes: number): LineFramer => {
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  return {
    push: (chunk) => {
      const lines: string[] = [];
      let start = 0;

      for (let lf = chunk.indexOf(10); lf !== -1; lf = chunk.indexOf(10, start)) {
        if (pendingBytes + lf - start > maxLineBytes) return undefined;
        const line = Buffer.concat([...pending, chunk.subarray(start, lf)]).toString('utf8');

        lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
        pending = [];
        pendingBytes = 0;
        start = lf + 1;
      }

      pendingBytes += chunk.length - start;

      if (pendingBytes > maxLineBytes) return undefined;

      if (start < chunk.length) pending.push(chunk.subarray(start));

      return lines;
    },
  };
};

export { createLineFramer, type LineFramer };
