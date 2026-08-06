import {
  parseAgentRequest,
  parseAgentResponse,
  parseConfig,
  parseMetricRequest,
  parseMetricResult,
  parseTrace,
} from '@attest/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

type Parser = (candidate: unknown) => unknown;
type MutableRecord = Record<string, unknown>;
type MutationKind = 'delete-key' | 'duplicate-array-entry' | 'inject-key' | 'retype-value';
type MutationInstruction = {
  index: number;
  kind: MutationKind;
  replacement: unknown;
};
type ValueLocation = {
  container: MutableRecord | unknown[];
  key: number | string;
};

const defaultIterationCount = 200;
const configuredIterationCount = Number.parseInt(
  process.env.FUZZ_ITERATIONS ?? String(defaultIterationCount),
  10,
);
const iterationCount =
  Number.isFinite(configuredIterationCount) && configuredIterationCount > 0
    ? configuredIterationCount
    : defaultIterationCount;

const validAgentRequest = {
  protocol: 'attest.agent/v1alpha1',
  run_id: '01J9ZK7Q2M5X8W4V3T2R1QPN0M',
  case_id: 'greeting-basic',
  input: { question: 'What is the capital of France?', tags: ['geography'] },
};
const validConfig = {
  config_version: 1,
  agent: { type: 'cli', command: ['node', 'agent.js'] },
  suites: [
    {
      name: 'smoke',
      metrics: ['answer-exists'],
      cases: [{ id: 'greeting', input: { question: 'Capital of France?' } }],
    },
  ],
  metrics: [
    {
      name: 'answer-exists',
      type: 'assertion',
      assert: [{ exists: { path: '$.output' } }],
    },
  ],
};
const validTrace = {
  schema: 'attest.trace/v1alpha1',
  trace_id: 'trace-1',
  spans: [
    {
      span_id: 'span-1',
      parent_span_id: null,
      name: 'agent.run',
      kind: 'agent',
      start_time: '2026-08-06T10:15:03.120Z',
      end_time: '2026-08-06T10:15:09.480Z',
      status: { code: 'ok' },
    },
  ],
};
const validAgentResponse = {
  protocol: 'attest.agent/v1alpha1',
  output: ['Paris'],
  trace: validTrace,
};
const validMetricRequest = {
  protocol: 'attest.metric/v1alpha1',
  case: { id: 'greeting', input: ['Capital of France?'] },
  output: 'Paris',
  trace: validTrace,
};
const validMetricResult = {
  score: 1,
  pass: true,
  details: { matched: ['$.output'] },
};

/** Supplies ordinary JSON noise to exercise every Phase 1 ingestion boundary. */
const jsonNoise = fc.jsonValue();

/** Includes non-JSON unknown values because callers can invoke parsers before serialization. */
const nonJsonNoise = fc.oneof(
  fc.anything(),
  fc.constant(() => undefined),
  fc.constant(Symbol('attest-fuzz')),
  fc.constant(undefined),
);

/** Builds simple alternating containers up to depth 200 to probe recursive validation safely. */
const deepStructures = fc
  .tuple(fc.integer({ min: 1, max: 200 }), fc.boolean(), fc.jsonValue())
  .map(([depth, startsWithArray, leaf]) => {
    let value: unknown = leaf;
    for (let level = 0; level < depth; level += 1) {
      const useArray = (level % 2 === 0) === startsWithArray;
      value = useArray ? [value] : { nested: value };
    }
    return value;
  });

const hostilePattern = '\u0000\u202e\ud800\udc00\ud800';
const oneMegabyteHostileString = hostilePattern
  .repeat(Math.ceil(1_048_576 / hostilePattern.length))
  .slice(0, 1_048_576);

/** Mixes Unicode edge cases with an explicit one-megabyte parser boundary value. */
const hostileStrings = fc.oneof(
  fc.string({ maxLength: 4_096 }),
  fc.constant('\u0000'),
  fc.constant('\u202eRTL'),
  fc.constant('\ud800\udc00'),
  fc.constant('\ud800'),
  fc.constant(oneMegabyteHostileString),
);

const mutationValues = fc.oneof(jsonNoise, nonJsonNoise, deepStructures, hostileStrings);
const mutationInstructions = fc.record({
  index: fc.nat(),
  kind: fc.constantFrom<MutationKind>(
    'delete-key',
    'duplicate-array-entry',
    'inject-key',
    'retype-value',
  ),
  replacement: mutationValues,
});

/** Narrows plain object containers used by the valid JSON seeds. */
const isMutableRecord = (value: unknown): value is MutableRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Collects nested mutation targets while keeping the mutation logic explicit and inspectable. */
const collectMutationTargets = (
  value: unknown,
  records: MutableRecord[],
  arrays: unknown[][],
  locations: ValueLocation[],
): void => {
  if (Array.isArray(value)) {
    arrays.push(value);
    value.forEach((entry, index) => {
      locations.push({ container: value, key: index });
      collectMutationTargets(entry, records, arrays, locations);
    });
    return;
  }

  if (!isMutableRecord(value)) {
    return;
  }

  records.push(value);
  Object.entries(value).forEach(([key, entry]) => {
    locations.push({ container: value, key });
    collectMutationTargets(entry, records, arrays, locations);
  });
};

/** Applies one shrinkable mutation to a fresh valid contract document. */
const mutateValidDocument = (
  seed: MutableRecord,
  instruction: MutationInstruction,
): MutableRecord => {
  const document = structuredClone(seed) as MutableRecord;
  const records: MutableRecord[] = [];
  const arrays: unknown[][] = [];
  const locations: ValueLocation[] = [];
  collectMutationTargets(document, records, arrays, locations);

  if (instruction.kind === 'delete-key') {
    const objectLocations = locations.filter(({ container }) => !Array.isArray(container));
    const target = objectLocations[instruction.index % objectLocations.length];
    if (target === undefined) {
      return document;
    }

    delete (target.container as MutableRecord)[target.key];
    return document;
  }

  if (instruction.kind === 'retype-value') {
    const target = locations[instruction.index % locations.length];
    if (target === undefined) {
      return document;
    }

    Reflect.set(target.container, target.key, instruction.replacement);
    return document;
  }

  if (instruction.kind === 'inject-key') {
    const target = records[instruction.index % records.length];
    if (target === undefined) {
      return document;
    }

    target[`fuzz_unknown_${instruction.index}`] = instruction.replacement;
    return document;
  }

  const nonEmptyArrays = arrays.filter((array) => array.length > 0);
  const target = nonEmptyArrays[instruction.index % nonEmptyArrays.length];
  if (target === undefined) {
    return document;
  }

  target.push(target[instruction.index % target.length]);
  return document;
};

/** Generates deeper validation cases by perturbing a document known to satisfy its contract. */
const mutatedValidDocument = (seed: MutableRecord) =>
  mutationInstructions.map((instruction) => mutateValidDocument(seed, instruction));

/** Keeps one structure-aware arbitrary per public parser contract. */
const mutatedValidDocuments = {
  agentRequest: mutatedValidDocument(validAgentRequest),
  agentResponse: mutatedValidDocument(validAgentResponse),
  config: mutatedValidDocument(validConfig),
  metricRequest: mutatedValidDocument(validMetricRequest),
  metricResult: mutatedValidDocument(validMetricResult),
  trace: mutatedValidDocument(validTrace),
};

/** Combines broad hostile inputs with contract-aware mutations for one parser property. */
const parserCandidates = (mutatedDocuments: fc.Arbitrary<MutableRecord>) =>
  fc.oneof(jsonNoise, nonJsonNoise, deepStructures, hostileStrings, mutatedDocuments);

/** Enforces the Phase 1 ingestion guarantee that parsers return shaped results instead of crashing. */
const expectCrashFreeResult = (parser: Parser, candidate: unknown): void => {
  let result: unknown;
  try {
    result = parser(candidate);
  } catch (error) {
    throw new Error('Contract parser threw instead of returning a result', { cause: error });
  }

  expect(result).not.toBeNull();
  expect(typeof result).toBe('object');
  if (result === null || typeof result !== 'object') {
    return;
  }

  expect(typeof Reflect.get(result, 'ok')).toBe('boolean');
};

/** Runs exactly one crash-freedom property for a public parser family. */
const assertParserNeverThrows = (
  parser: Parser,
  mutatedDocuments: fc.Arbitrary<MutableRecord>,
): void => {
  fc.assert(
    fc.property(parserCandidates(mutatedDocuments), (candidate) => {
      expectCrashFreeResult(parser, candidate);
    }),
    { numRuns: iterationCount },
  );
};

describe.skipIf(process.env.FUZZ !== '1')(
  'contract parser crash freedom (set FUZZ=1 to run)',
  () => {
    it('never throws while parsing agent requests', () => {
      assertParserNeverThrows(parseAgentRequest, mutatedValidDocuments.agentRequest);
    });

    it('never throws while parsing agent responses', () => {
      assertParserNeverThrows(parseAgentResponse, mutatedValidDocuments.agentResponse);
    });

    it('never throws while parsing configs', () => {
      assertParserNeverThrows(parseConfig, mutatedValidDocuments.config);
    });

    it('never throws while parsing traces', () => {
      assertParserNeverThrows(parseTrace, mutatedValidDocuments.trace);
    });

    it('never throws while parsing metric requests', () => {
      assertParserNeverThrows(parseMetricRequest, mutatedValidDocuments.metricRequest);
    });

    it('never throws while parsing metric results', () => {
      assertParserNeverThrows(parseMetricResult, mutatedValidDocuments.metricResult);
    });
  },
);

export { deepStructures, hostileStrings, jsonNoise, mutatedValidDocuments };
