/** One stream record; heartbeats carry no payload but still count toward caps. */
type StreamEvent =
  { heartbeat: true; source: string } | { heartbeat: false; eventName?: string; source: string };

/** Converts SSE lines into complete events while preserving comment heartbeats. */
class SseParser {
  private data: string[] = [];
  private eventName?: string;

  /** Reports buffered event data before dispatch so authored caps apply first. */
  get bufferedDataBytes(): number {
    return Buffer.byteLength(this.data.join('\n'));
  }

  push(line: string): StreamEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return { heartbeat: true, source: line };
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') this.eventName = value;
    if (field === 'data') this.data.push(value);
    return undefined;
  }

  /** A blank line ends an event; one without data only resets the event name. */
  private dispatch(): StreamEvent | undefined {
    const event: StreamEvent | undefined =
      this.data.length === 0
        ? undefined
        : { heartbeat: false, eventName: this.eventName, source: this.data.join('\n') };
    this.data = [];
    this.eventName = undefined;
    return event;
  }
}

export { SseParser, type StreamEvent };
