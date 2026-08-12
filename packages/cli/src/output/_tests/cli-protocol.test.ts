import { describe, expect, it } from 'vitest';

import {
  CliEventSerializer,
  createCliFailureResult,
  createCliSuccessResult,
  serializeCliResult,
} from '../cli-protocol.js';

describe('CLI protocol serialization', () => {
  it('serializes success and failure as one deterministic JSON document', () => {
    const success = createCliSuccessResult('project.show', { project_id: 'project-1' });
    const failure = createCliFailureResult('project.show', {
      code: 'project_changed',
      message: 'The project changed.',
      retryable: true,
    });

    expect(serializeCliResult(success)).toBe(
      '{"schema":"attest.cli-result/v1","ok":true,"command":"project.show","project_hash_before":null,"project_hash_after":null,"result":{"project_id":"project-1"},"warnings":[]}',
    );
    expect(serializeCliResult(failure)).toBe(
      '{"schema":"attest.cli-result/v1","ok":false,"command":"project.show","error":{"code":"project_changed","message":"The project changed.","retryable":true}}',
    );
  });

  it('serializes JSONL events with stable sequence and injected time', () => {
    const times = [new Date('2026-08-07T12:00:00.000Z'), new Date('2026-08-07T12:00:01.000Z')];
    const serializer = new CliEventSerializer(() => times.shift() ?? new Date(0));

    expect(serializer.serialize('run_started', { run_id: 'run-1' })).toBe(
      '{"schema":"attest.cli-event/v1","sequence":0,"time":"2026-08-07T12:00:00.000Z","event":"run_started","data":{"run_id":"run-1"}}',
    );
    expect(serializer.serialize('result', { ok: true })).toBe(
      '{"schema":"attest.cli-event/v1","sequence":1,"time":"2026-08-07T12:00:01.000Z","event":"result","data":{"ok":true}}',
    );
  });

  it('rejects invalid command and event identities before serialization', () => {
    expect(() => createCliSuccessResult('Project Show', {})).toThrow();
    expect(() => new CliEventSerializer().serialize('RunStarted', {})).toThrow();
  });
});
