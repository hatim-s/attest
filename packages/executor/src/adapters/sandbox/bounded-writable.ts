import { createHash, type Hash } from 'node:crypto';
import { Writable } from 'node:stream';

import { BoundedTail } from '../../internal/bounded-tail.js';

/** Captures a bounded stdout prefix, hashes all received bytes, and aborts at the cap. */
class BoundedOutputWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  private readonly hash: Hash = createHash('sha256');
  private retainedBytes = 0;
  private receivedBytes = 0;
  exceeded = false;

  constructor(
    private readonly capBytes: number,
    private readonly onExceeded: () => void,
  ) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.receivedBytes += buffer.length;
    this.hash.update(buffer);
    const remaining = Math.max(0, this.capBytes - this.retainedBytes);
    if (remaining > 0) {
      const retained = buffer.subarray(0, remaining);
      this.chunks.push(retained);
      this.retainedBytes += retained.length;
    }
    if (!this.exceeded && this.receivedBytes > this.capBytes) {
      this.exceeded = true;
      this.onExceeded();
    }
    callback();
  }

  /** Returns only bytes within the configured cap. */
  buffer(): Buffer {
    return Buffer.concat(this.chunks, this.retainedBytes);
  }

  digest(): string {
    return this.hash.copy().digest('hex');
  }
}

/** Retains a bounded diagnostics tail without exerting unbounded backpressure on SDK log delivery. */
class BoundedTailWritable extends Writable {
  private readonly tail: BoundedTail;

  constructor(capBytes: number) {
    super();
    this.tail = new BoundedTail(capBytes);
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.tail.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  text(): string | undefined {
    return this.tail.text();
  }
}

export { BoundedOutputWritable, BoundedTailWritable };
