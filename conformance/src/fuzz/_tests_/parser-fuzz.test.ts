import {
  agentRequestSchema,
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
  traceSchema,
} from '@attest/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadFixtures } from '../../../../packages/contracts/src/_tests_/support/load-fixtures.js';

const iterationCount = Number.parseInt(process.env.FUZZ_ITERATIONS ?? '200', 10);

const options = {
  numRuns: Number.isFinite(iterationCount) && iterationCount > 0 ? iterationCount : 200,
};

const fixtures = loadFixtures();

const seed = (contract: string, name: string) => {
  const fixture = fixtures.find(
    (fixture) => fixture.contract === contract && fixture.name === name,
  );

  if (fixture === undefined) throw new Error(`Missing fuzz seed ${contract}/${name}`);

  return fixture.envelope.input;
};

const request = agentRequestSchema.parse(
  seed('agent-request', '01-valid-minimal-single-turn.json'),
);

const trace = traceSchema.parse(
  seed('trace', '02-valid-nested-spans-events-and-gen-ai-attributes.json'),
);

const span = trace.spans[0]!;

const parsers = {
  parseAgentRequest,
  parseAgentResponse,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
};

const noise = fc.oneof(
  fc.jsonValue(),
  fc.anything(),
  fc.constant(Symbol('fuzz')),
  fc.constant(() => undefined),
);

const deepPayload = fc
  .tuple(fc.integer({ min: 1, max: 200 }), fc.jsonValue())
  .map(([depth, leaf]) => {
    let value: fc.JsonValue = leaf;

    for (let level = 0; level < depth; level += 1)
      value = level % 2 === 0 ? [value] : { nested: value };

    return value;
  });

describe.skipIf(process.env.FUZZ !== '1')('contract parser properties (set FUZZ=1 to run)', () => {
  it.each(Object.entries(parsers))(
    '%s returns a result for JSON and non-JSON input',
    (_name, parse) => {
      fc.assert(
        fc.property(noise, (candidate) => {
          expect(parse(candidate).ok).toBeTypeOf('boolean');
        }),
        options,
      );
    },
  );

  it('requires exactly one agent outcome for every JSON output', () => {
    const outcomes = fc.record(
      {
        protocol: fc.constant(request.protocol),
        output: fc.jsonValue(),
        error: fc.record({ message: fc.string() }),
      },
      { requiredKeys: ['protocol'] },
    );

    fc.assert(
      fc.property(outcomes, (candidate) => {
        expect(parseAgentResponse(candidate).ok).toBe(
          Object.hasOwn(candidate, 'output') !== Object.hasOwn(candidate, 'error'),
        );
      }),
      options,
    );
  });

  it('requires all or none of the multi-turn fields', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), fc.string(), (mask, content) => {
        const candidate = { ...request };

        if (mask & 1) candidate.messages = [{ role: 'user', content }];

        if (mask & 2) candidate.turn_index = 0;

        if (mask & 4) candidate.conversation_id = 'conversation';

        expect(parseAgentRequest(candidate).ok).toBe(mask === 0 || mask === 7);
      }),
      options,
    );
  });

  it('accepts bounded deep JSON at the input payload', () => {
    fc.assert(
      fc.property(deepPayload, (input) => {
        expect(parseAgentRequest({ ...request, input }).ok).toBe(true);
      }),
      options,
    );
  });

  it('accepts unique span identities and rejects an appended duplicate', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 }),
        (ids) => {
          const spans = ids.map((span_id) => ({ ...span, span_id, parent_span_id: null }));
          expect(parseTrace({ ...trace, spans }).ok).toBe(true);
          const result = parseTrace({ ...trace, spans: [...spans, spans[0]!] });
          expect(result.ok).toBe(false);

          if (!result.ok)
            expect(result.error).toContainEqual(
              expect.objectContaining({ path: `spans.${spans.length}.span_id` }),
            );
        },
      ),
      options,
    );
  });

  it('accepts finite metric scores and rejects non-finite scores', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.boolean(),
        (score, pass) => {
          expect(parseMetricResult({ score, pass }).ok).toBe(true);
        },
      ),
      options,
    );
    fc.assert(
      fc.property(fc.constantFrom(NaN, Infinity, -Infinity), (score) => {
        expect(parseMetricResult({ score, pass: true }).ok).toBe(false);
      }),
      options,
    );
  });
});
