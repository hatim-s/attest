/** Retains the newest bytes of a diagnostic stream, bounded so noisy agents cannot grow memory. */
class BoundedTail {
  private retained: Buffer = Buffer.alloc(0);

  constructor(private readonly capBytes: number) {}

  append(chunk: Buffer): void {
    const combined = Buffer.concat([this.retained, chunk]);
    this.retained = combined.subarray(Math.max(0, combined.length - this.capBytes));
  }

  /** Decodes the tail as UTF-8, or undefined when nothing was written. */
  text(): string | undefined {
    if (this.retained.length === 0) return undefined;
    let offset = 0;
    // UTF-8 continuation bytes cannot begin a code point, so drop only the split prefix.
    while (offset < this.retained.length && (this.retained[offset]! & 0xc0) === 0x80) offset += 1;
    return this.retained.subarray(offset).toString('utf8');
  }
}

export { BoundedTail };
