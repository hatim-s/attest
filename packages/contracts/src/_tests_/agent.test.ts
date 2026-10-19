import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  agentRequestSchema,
  type AgentErrorResponse,
  type AgentResponse,
  type AgentSuccessResponse,
} from '../agent/protocol.js';
import { agentCompletionSchema } from '../agent/completion.js';
import { inlineArtifactSchema } from '../agent/artifact.js';
import { parseAgentResponse } from '../schema/parse.js';
import { AGENT_COMPLETION_PROTOCOL, AGENT_PROTOCOL } from '../schema/identifiers.js';

const request = {
  protocol: AGENT_PROTOCOL,
  run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  case_id: 'case-01',
  input: { question: 'Ready?' },
};

describe('agentResponseSchema', () => {
  it.each([
    { protocol: AGENT_PROTOCOL, output: undefined },
    { protocol: AGENT_PROTOCOL, error: undefined },
  ])('rejects a response without exactly one outcome', (response) => {
    const result = parseAgentResponse(response);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.errors).toContainEqual({
      path: 'output',
      message: 'exactly one of output or error must be present',
    });
  });

  it('infers a response union that narrows to one terminal outcome', () => {
    expectTypeOf<AgentResponse>().toEqualTypeOf<AgentSuccessResponse | AgentErrorResponse>();

    const readOutcome = (
      response: AgentResponse,
    ): AgentSuccessResponse['output'] | AgentErrorResponse['error'] => {
      if ('output' in response) {
        expectTypeOf(response).toEqualTypeOf<AgentSuccessResponse>();

        return response.output;
      }

      expectTypeOf(response).toEqualTypeOf<AgentErrorResponse>();

      return response.error;
    };

    expect(readOutcome({ protocol: AGENT_PROTOCOL, output: 'Paris' })).toBe('Paris');
  });
});

const inlineArtifact = {
  kind: 'inline',
  path: 'src/index.ts',
  media_type: 'text/typescript',
  encoding: 'utf8',
  content: 'export {};\n',
} as const;

describe('artifact paths', () => {
  it.each(['answer.ts', 'src/index.ts', '.hidden/config.json', 'notes/...', 'a b/c d.txt'])(
    'accepts the canonical file path %j',
    (path) => {
      expect(inlineArtifactSchema.safeParse({ ...inlineArtifact, path }).success).toBe(true);
    },
  );

  it.each([
    '',
    '..',
    'src/../index.ts',
    '/etc/passwd',
    'C:/index.ts',
    '.',
    './index.ts',
    'src//index.ts',
    'src/',
    'src\\index.ts',
    'src/./index.ts',
    'src/\u0000index.ts',
    `${'a'.repeat(256)}.ts`,
  ])('rejects the non-canonical or escaping path %j', (path) => {
    expect(inlineArtifactSchema.safeParse({ ...inlineArtifact, path }).success).toBe(false);
  });
});

describe('agent envelopes with artifacts and callbacks', () => {
  it('keeps inline response artifacts as a known field', () => {
    const result = parseAgentResponse({
      protocol: AGENT_PROTOCOL,
      output: 'done',
      artifacts: [inlineArtifact],
    });

    expect(result).toEqual({
      ok: true,
      value: { protocol: AGENT_PROTOCOL, output: 'done', artifacts: [inlineArtifact] },
      warnings: [],
    });
  });

  it('rejects reference artifacts in a response', () => {
    const result = parseAgentResponse({
      protocol: AGENT_PROTOCOL,
      output: 'done',
      artifacts: [{ kind: 'reference', path: 'out.png', id: 'artifact-1' }],
    });

    expect(result.ok).toBe(false);
  });

  it.each([
    { url: 'https://attest.example/attest/completions/run/case', token: 'secret' },
    { url: 'http://127.0.0.1:4100/attest/completions/run/case', token: 'secret' },
  ])('accepts the callback $url', (callback) => {
    expect(agentRequestSchema.safeParse({ ...request, callback }).success).toBe(true);
  });

  it.each([
    { url: 'ftp://attest.example/completions', token: 'secret' },
    { url: 'not a url', token: 'secret' },
    { url: 'https://attest.example/completions', token: '' },
    { url: 'https://attest.example/completions', token: 'secret', extra: true },
  ])('rejects the callback %j', (callback) => {
    expect(agentRequestSchema.safeParse({ ...request, callback }).success).toBe(false);
  });
});

describe('agentCompletionSchema', () => {
  const completion = {
    protocol: AGENT_COMPLETION_PROTOCOL,
    run_id: request.run_id,
    case_id: request.case_id,
    output: 'Wrote answer.ts',
  };

  it('accepts inline and reference artifacts with a trace reference', () => {
    expect(
      agentCompletionSchema.safeParse({
        ...completion,
        trace_ref: 'trace-1',
        artifacts: [
          inlineArtifact,
          { kind: 'reference', path: 'shots/home.png', media_type: 'image/png', id: 'blob-1' },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    { name: 'both outcomes', candidate: { ...completion, error: { message: 'failed' } } },
    { name: 'no outcome', candidate: { ...completion, output: undefined } },
  ])('rejects $name', ({ candidate }) => {
    expect(agentCompletionSchema.safeParse(candidate).error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['output'],
        message: 'exactly one of output or error must be present',
      }),
    );
  });

  it('rejects an inline trace together with a trace reference', () => {
    const result = agentCompletionSchema.safeParse({
      ...completion,
      trace: {},
      trace_ref: 'trace-1',
    });

    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['trace_ref'],
        message: 'trace and trace_ref are mutually exclusive',
      }),
    );
  });

  it.each([
    { ...completion, protocol: AGENT_PROTOCOL },
    { ...completion, run_id: 'run-1' },
    { ...completion, vendor: true },
    { ...completion, trace_ref: '' },
    { ...completion, artifacts: [{ kind: 'reference', path: 'a.png', id: '' }] },
  ])('rejects the malformed completion %#', (candidate) => {
    expect(agentCompletionSchema.safeParse(candidate).success).toBe(false);
  });
});
