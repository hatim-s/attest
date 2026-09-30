import { z } from 'zod';

import {
  agentAddRequestSchema,
  agentImportRequestSchema,
  agentRemoveRequestSchema,
  agentRenameRequestSchema,
  agentTestRequestSchema,
} from './command-request/agent.js';
import {
  metricAddRequestSchema,
  metricImportRequestSchema,
  metricRemoveRequestSchema,
  metricRenameRequestSchema,
  metricTestRequestSchema,
} from './command-request/metric.js';
import { projectInitRequestSchema, projectUnlockRequestSchema } from './command-request/project.js';
import {
  testAddRequestSchema,
  testCaseAddRequestSchema,
  testCaseImportRequestSchema,
  testCaseRemoveRequestSchema,
  testCaseRenameRequestSchema,
  testDatasetAddRequestSchema,
  testDatasetAttachRequestSchema,
  testDatasetDetachRequestSchema,
  testDatasetImportRequestSchema,
  testDatasetRemoveRequestSchema,
  testDatasetRenameRequestSchema,
  testMetricAttachRequestSchema,
  testMetricDetachRequestSchema,
  testRemoveRequestSchema,
  testRenameRequestSchema,
} from './command-request/test.js';
import { evalCancelRequestSchema } from '../eval/cancel.js';
import { evalRunRequestSchema } from '../eval/run.js';

/** Encodes every normalized project-authoring request accepted through --from-json. */
const commandRequestSchema = z.union([
  projectInitRequestSchema,
  projectUnlockRequestSchema,
  agentAddRequestSchema,
  agentImportRequestSchema,
  agentRenameRequestSchema,
  agentRemoveRequestSchema,
  agentTestRequestSchema,
  testAddRequestSchema,
  testCaseAddRequestSchema,
  testCaseImportRequestSchema,
  testCaseRenameRequestSchema,
  testCaseRemoveRequestSchema,
  testDatasetAddRequestSchema,
  testDatasetImportRequestSchema,
  testDatasetAttachRequestSchema,
  testDatasetDetachRequestSchema,
  testDatasetRenameRequestSchema,
  testDatasetRemoveRequestSchema,
  testMetricAttachRequestSchema,
  testMetricDetachRequestSchema,
  testRenameRequestSchema,
  testRemoveRequestSchema,
  metricAddRequestSchema,
  metricImportRequestSchema,
  metricTestRequestSchema,
  metricRenameRequestSchema,
  metricRemoveRequestSchema,
  evalRunRequestSchema,
  evalCancelRequestSchema,
]);

type CommandRequest = z.infer<typeof commandRequestSchema>;

export { commandRequestSchema, type CommandRequest };
