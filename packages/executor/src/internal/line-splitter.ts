type SplitLines = {
  /** Complete lines, without their `\n` or `\r\n` terminator. */
  lines: string[];
  /** A line, complete or still buffering, exceeded the byte cap; no later line is returned. */
  overflow: boolean;
};

/**
 * Splits decoded stream text into lines while bounding each line, including one still waiting
 * for its newline, so a peer cannot grow the buffer without limit.
 */
class LineSplitter {
  private buffer = '';

  constructor(private readonly maximumLineBytes: number) {}

  push(text: string): SplitLines {
    this.buffer += text;
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (this.exceedsCap(line)) return { lines, overflow: true };
      lines.push(line);
    }
    return { lines, overflow: this.exceedsCap(this.buffer) };
  }

  /** Flushes an unterminated final line at end of stream. */
  end(): SplitLines {
    if (this.buffer.length === 0) return { lines: [], overflow: false };
    const line = this.buffer.replace(/\r$/u, '');
    this.buffer = '';
    if (this.exceedsCap(line)) return { lines: [], overflow: true };
    return { lines: [line], overflow: false };
  }

  private exceedsCap(text: string): boolean {
    return Buffer.byteLength(text) > this.maximumLineBytes;
  }
}

export { LineSplitter, type SplitLines };
