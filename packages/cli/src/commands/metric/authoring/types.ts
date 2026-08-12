import type { MetricPresetId } from '@attest/contracts';

import type { ReadInput } from '../../agent/agent-request.js';

type Prompt = (question: string, options?: { signal?: AbortSignal }) => Promise<string>;

type MetricAddFields = {
  argContains?: readonly string[];
  argEquals?: readonly string[];
  argExists?: readonly string[];
  argvJson?: string;
  assertJson?: readonly string[];
  attribute?: readonly string[];
  bodyJson?: string;
  count?: string;
  cwd?: string;
  detailsPointer?: string;
  env?: readonly string[];
  flags?: string;
  gte?: string;
  gt?: string;
  headerEnv?: readonly string[];
  httpMethod?: string;
  jsonSchema?: string;
  jsonSchemaFile?: string;
  lte?: string;
  lt?: string;
  metricId: string;
  model?: string;
  name?: string;
  order?: readonly string[];
  passPointer?: string;
  path?: string;
  pattern?: string;
  preset?: MetricPresetId;
  queryEnv?: readonly string[];
  rationalePointer?: string;
  readStdin: ReadInput;
  rubric?: string;
  rubricFile?: string;
  scorePointer?: string;
  spanKind?: string;
  spanName?: string;
  spanStatus?: string;
  threshold?: string;
  timeout?: string;
  tool?: string;
  toolStatus?: string;
  url?: string;
  value?: string;
  workingDirectory: string;
};

export { type MetricAddFields, type Prompt };
