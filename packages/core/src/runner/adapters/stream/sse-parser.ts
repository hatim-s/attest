import type { StreamEvent } from './types.js';

/** Converts bounded SSE bytes into complete events while preserving comment heartbeats. */
class SseParser {
  private data: string[] = [];
  private eventName?: string;

  push(line: string): StreamEvent | undefined {
    if (line === '') {
      if (this.data.length === 0) {
        this.eventName = undefined;
        return undefined;
      }
      const source = this.data.join('\n');
      const event = {
        eventName: this.eventName,
        heartbeat: false,
        raw: JSON.parse(source) as unknown,
        source,
      };
      this.data = [];
      this.eventName = undefined;
      return event;
    }
    if (line.startsWith(':')) return { heartbeat: true, raw: null, source: line };
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') this.eventName = value;
    if (field === 'data') this.data.push(value);
    return undefined;
  }
}

export { SseParser };
