import { AgentInvocationError } from '../../errors.js';
import {
  DEFAULT_EVENT_BYTES,
  DEFAULT_EVENT_COUNT,
  DEFAULT_IDLE_MS,
  DEFAULT_TOTAL_EVIDENCE_BYTES,
} from '../../internal/agent-defaults.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
import type { StreamEvent } from './sse-parser.js';
import type { StreamAgentResource } from './stream-adapter.js';

/** Resolved stream limits; each bounds one way a peer could grow memory or stall forever. */
type StreamCaps = {
  eventBytes: number;
  eventCount: number;
  totalBytes: number;
  idleMs: number;
};

/** Applies the defaults for every stream limit the agent leaves unset. */
const createStreamCaps = (agent: StreamAgentResource): StreamCaps => ({
  eventBytes: agent.limits?.event_bytes ?? DEFAULT_EVENT_BYTES,
  eventCount: agent.limits?.event_count ?? DEFAULT_EVENT_COUNT,
  totalBytes: agent.limits?.total_evidence_bytes ?? DEFAULT_TOTAL_EVIDENCE_BYTES,
  idleMs: agent.timeouts?.idle_ms ?? DEFAULT_IDLE_MS,
});

const capError = (message: string): AgentInvocationError =>
  new AgentInvocationError('output_cap_exceeded', message);

/**
 * Counts accepted events against the caps and keeps their redacted text as attempt evidence.
 * Once an application event arrives the request may have side effects, so it is never replayed.
 */
class StreamEvidence {
  text = '';
  applicationStarted = false;
  private eventCount = 0;

  constructor(
    private readonly agent: StreamAgentResource,
    private readonly caps: StreamCaps,
    private readonly secrets: readonly string[],
  ) {}

  /** Records one event; `raw` is the parsed payload of an application event. */
  record(event: StreamEvent, raw?: unknown): void {
    if (Buffer.byteLength(event.source) > this.caps.eventBytes) {
      throw capError('Streaming response event exceeds its event byte cap.');
    }
    this.eventCount += 1;
    if (this.eventCount > this.caps.eventCount) {
      throw capError('Streaming response exceeds its event count cap.');
    }
    if (event.heartbeat) {
      this.text += `${redactTransportText(event.source, this.secrets)}\n`;
      return;
    }
    const pointers = this.agent.redaction?.event_pointers ?? [];
    this.text += `${redactEventEvidence(raw, pointers, this.secrets)}\n`;
    this.applicationStarted = true;
  }
}

export { StreamEvidence, capError, createStreamCaps, type StreamCaps };
