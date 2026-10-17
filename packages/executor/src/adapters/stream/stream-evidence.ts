import type { JsonValue } from '@attest/contracts';
import { AgentInvocationError } from '../../errors.js';
import {
  DEFAULT_EVENT_BYTES,
  DEFAULT_EVENT_COUNT,
  DEFAULT_IDLE_MS,
  DEFAULT_TOTAL_EVIDENCE_BYTES,
} from '../../internal/agent-defaults.js';
import { redactEventEvidence, redactTransportText } from '../http/redaction.js';
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

  /** Records a comment heartbeat, which counts toward the caps but carries no payload. */
  recordHeartbeat(source: string): void {
    this.count(source);
    this.text += `${redactTransportText(source, this.secrets)}\n`;
  }

  /** Records an application event with its parsed payload. */
  recordEvent(source: string, raw: JsonValue): void {
    this.count(source);
    const pointers = this.agent.redaction?.event_pointers ?? [];
    this.text += `${redactEventEvidence(raw, pointers, this.secrets)}\n`;
    this.applicationStarted = true;
  }

  private count(source: string): void {
    if (Buffer.byteLength(source) > this.caps.eventBytes) {
      throw capError('Streaming response event exceeds its event byte cap.');
    }

    this.eventCount += 1;

    if (this.eventCount > this.caps.eventCount) {
      throw capError('Streaming response exceeds its event count cap.');
    }
  }
}

export { StreamEvidence, capError, createStreamCaps, type StreamCaps };
