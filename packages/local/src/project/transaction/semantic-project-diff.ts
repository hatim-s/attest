import { z } from 'zod';
import type { ProjectResources, JsonValue } from '@attest/contracts';

import { contentHash, canonicalStringify } from '@attest/core';

import { escapeJsonPointerSegment } from '../../internal/json-pointer.js';
import { datasetMetadataForHash } from '../canonical-project.js';
import type { LoadedProject } from '../project-loader/index.js';
import { ProjectTransactionError } from './project-transaction-error.js';
import type {
  ProjectRenameHint,
  ProjectResourceKind,
  SemanticFieldChange,
  SemanticProjectDiff,
  SemanticProjectOperation,
  SemanticReference,
} from './transaction-types.js';

type ResourceValue = JsonValue & { id: string };

type IdentityValue = Record<string, JsonValue> & { id: string };

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentityValue(value: JsonValue): value is IdentityValue {
  return isJsonRecord(value) && typeof value.id === 'string';
}

const identityValues = (values: readonly JsonValue[]): IdentityValue[] | undefined => {
  const records: IdentityValue[] = [];
  const ids = new Set<string>();

  for (const value of values) {
    if (!isIdentityValue(value) || ids.has(value.id)) return undefined;

    ids.add(value.id);
    records.push(value);
  }

  return records;
};

/** Diffs case arrays by stable ids so removals do not masquerade as positional rewrites. */
const diffIdentityArray = (
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  path: string,
): SemanticFieldChange[] | undefined => {
  if (!path.endsWith('/cases') || before.length + after.length === 0) return undefined;
  const beforeRecords = identityValues(before);
  const afterRecords = identityValues(after);

  if (beforeRecords === undefined || afterRecords === undefined) return undefined;
  const beforeById = new Map(beforeRecords.map((value) => [value.id, value]));
  const afterById = new Map(afterRecords.map((value) => [value.id, value]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();

  const changes = ids.flatMap((id) => {
    const childPath = `${path}/${escapeJsonPointerSegment(id)}`;
    const oldValue = beforeById.get(id);
    const newValue = afterById.get(id);

    if (oldValue === undefined) return [{ change: 'add' as const, path: childPath }];

    if (newValue === undefined) return [{ change: 'remove' as const, path: childPath }];

    return diffJsonFields(oldValue, newValue, childPath);
  });

  // Preserve order semantics only when the membership itself is unchanged.
  if (
    beforeById.size === afterById.size &&
    ids.every((id) => beforeById.has(id) && afterById.has(id)) &&
    beforeRecords.some((value, index) => value.id !== afterRecords[index]?.id)
  ) {
    changes.push({ change: 'update', path: `${path}/@order` });
  }

  return changes;
};

/** Produces deterministic field-level changes without including authored values. */
const diffJsonFields = (before: JsonValue, after: JsonValue, path = ''): SemanticFieldChange[] => {
  if (Object.is(before, after)) {
    return [];
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const identityChanges = diffIdentityArray(before, after, path);

    if (identityChanges !== undefined) return identityChanges;
    const changes: SemanticFieldChange[] = [];
    const length = Math.max(before.length, after.length);

    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}/${index}`;

      if (index >= before.length) {
        changes.push({ change: 'add', path: childPath });
      } else if (index >= after.length) {
        changes.push({ change: 'remove', path: childPath });
      } else {
        changes.push(...diffJsonFields(before[index]!, after[index]!, childPath));
      }
    }

    return changes;
  }

  if (isJsonRecord(before) && isJsonRecord(after)) {
    const beforeRecord = before;
    const afterRecord = after;

    return [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
      .sort()
      .flatMap((key) => {
        const childPath = `${path}/${escapeJsonPointerSegment(key)}`;

        if (!(key in beforeRecord)) {
          return [{ change: 'add' as const, path: childPath }];
        }

        if (!(key in afterRecord)) {
          return [{ change: 'remove' as const, path: childPath }];
        }

        return diffJsonFields(beforeRecord[key]!, afterRecord[key]!, childPath);
      });
  }

  return [{ change: 'update', path: path || '' }];
};

const referencesForProject = (project: ProjectResources): SemanticReference[] => {
  const references: SemanticReference[] = [];
  project.tests.forEach((test) => {
    references.push({ id: test.agent_id, path: `/tests/${test.id}/agent_id`, type: 'agent' });
    test.metrics.forEach(({ metric_id: id }, index) =>
      references.push({ id, path: `/tests/${test.id}/metrics/${index}`, type: 'metric' }),
    );
    test.datasets.forEach(({ dataset_id: id }, index) =>
      references.push({ id, path: `/tests/${test.id}/datasets/${index}`, type: 'dataset' }),
    );
    test.cases.forEach((testCase, caseIndex) =>
      testCase.metric_overrides?.forEach(({ metric_id: id }, overrideIndex) =>
        references.push({
          id,
          path: `/tests/${test.id}/cases/${caseIndex}/metric_overrides/${overrideIndex}`,
          type: 'metric',
        }),
      ),
    );
  });
  project.datasets.forEach((dataset) =>
    dataset.cases.forEach((testCase, caseIndex) =>
      testCase.metric_overrides?.forEach(({ metric_id: id }, overrideIndex) =>
        references.push({
          id,
          path: `/datasets/${dataset.metadata.id}/cases/${caseIndex}/metric_overrides/${overrideIndex}`,
          type: 'metric',
        }),
      ),
    ),
  );

  return references.sort((left, right) =>
    `${left.path}:${left.type}:${left.id}`.localeCompare(`${right.path}:${right.type}:${right.id}`),
  );
};

const referenceKey = ({ id, path, type }: SemanticReference): string => `${type}:${id}:${path}`;

const diffReferences = (before: ProjectResources, after: ProjectResources) => {
  const oldReferences = referencesForProject(before);
  const newReferences = referencesForProject(after);
  const oldKeys = new Set(oldReferences.map(referenceKey));
  const newKeys = new Set(newReferences.map(referenceKey));

  return {
    added: newReferences.filter((reference) => !oldKeys.has(referenceKey(reference))),
    removed: oldReferences.filter((reference) => !newKeys.has(referenceKey(reference))),
  };
};

const RESOURCE_VALUES = {
  agent: (project: ProjectResources) => project.agents,
  dataset: (project: ProjectResources) =>
    project.datasets.map(({ cases, metadata }) => ({
      ...z.record(z.string(), z.json()).parse(datasetMetadataForHash(metadata)),
      id: metadata.id,
      cases,
    })),
  metric: (project: ProjectResources) => project.metrics,
  test: (project: ProjectResources) => project.tests,
};

const valuesByKind = (
  project: ProjectResources,
  kind: Exclude<ProjectResourceKind, 'project'>,
): ReadonlyMap<string, ResourceValue> => {
  // Every resource is a validated JSON object with a string id.
  const values = RESOURCE_VALUES[kind](project).map((value) =>
    z
      .record(z.string(), z.json())
      .and(z.object({ id: z.string() }))
      .parse(JSON.parse(canonicalStringify(value))),
  );

  return new Map(values.map((value) => [value.id, value]));
};

const referencesForResource = (
  references: readonly SemanticReference[],
  kind: ProjectResourceKind,
  id: string,
): SemanticReference[] =>
  references.filter((reference) =>
    kind === 'test' ? reference.path.startsWith(`/tests/${id}/`) : reference.id === id,
  );

type OperationOptions = {
  after?: JsonValue;
  before?: JsonValue;
  id: string;
  kind: ProjectResourceKind;
  op: SemanticProjectOperation['op'];
  previousId?: string;
  references: { added: readonly SemanticReference[]; removed: readonly SemanticReference[] };
};

const makeOperation = ({
  after,
  before,
  id,
  kind,
  op,
  previousId,
  references,
}: OperationOptions): SemanticProjectOperation => {
  const assembledFields: SemanticProjectOperation = {
    changes:
      before === undefined || after === undefined ? [] : diffJsonFields(before, after).sort(byPath),
    op,
    references_added: referencesForResource(references.added, kind, id),
    references_removed: referencesForResource(references.removed, kind, previousId ?? id),
    resource: { id, type: kind },
  };

  if (!(after === undefined)) {
    assembledFields.new_content_hash = contentHash(after);
  }

  if (!(before === undefined)) {
    assembledFields.old_content_hash = contentHash(before);
  }

  if (!(previousId === undefined)) {
    assembledFields.previous_id = previousId;
  }

  return assembledFields;
};

const byPath = (left: SemanticFieldChange, right: SemanticFieldChange): number =>
  left.path.localeCompare(right.path);

const operationKey = (operation: SemanticProjectOperation): string =>
  `${operation.resource.type}:${operation.resource.id}:${operation.op}`;

/** Computes the stable semantic model shared by preview and commit results. */
const createSemanticProjectDiff = (
  before: LoadedProject,
  after: ProjectResources,
  options: { renames?: readonly ProjectRenameHint[]; warnings?: readonly string[] } = {},
): SemanticProjectDiff => {
  const references = diffReferences(before, after);
  const operations: SemanticProjectOperation[] = [];
  const renameKeys = new Set<string>();

  for (const rename of options.renames ?? []) {
    const oldValues = valuesByKind(before, rename.type);
    const newValues = valuesByKind(after, rename.type);
    const oldValue = oldValues.get(rename.from);
    const newValue = newValues.get(rename.to);

    if (oldValue === undefined || newValue === undefined || oldValues.has(rename.to)) {
      throw new ProjectTransactionError(
        'project_invalid',
        'Rename hint does not match candidate.',
        { details: { rename } },
      );
    }

    renameKeys.add(`${rename.type}:${rename.from}`);
    renameKeys.add(`${rename.type}:${rename.to}`);
    operations.push(
      makeOperation({
        op: 'rename',
        kind: rename.type,
        id: rename.to,
        before: oldValue,
        after: newValue,
        references,
        previousId: rename.from,
      }),
    );
  }

  for (const kind of ['agent', 'dataset', 'metric', 'test'] as const) {
    const oldValues = valuesByKind(before, kind);
    const newValues = valuesByKind(after, kind);
    const ids = [...new Set([...oldValues.keys(), ...newValues.keys()])].sort();

    for (const id of ids) {
      if (renameKeys.has(`${kind}:${id}`)) {
        continue;
      }

      const oldValue = oldValues.get(id);
      const newValue = newValues.get(id);

      if (oldValue === undefined && newValue !== undefined) {
        operations.push(makeOperation({ op: 'add', kind, id, after: newValue, references }));
      } else if (oldValue !== undefined && newValue === undefined) {
        operations.push(makeOperation({ op: 'remove', kind, id, before: oldValue, references }));
      } else if (
        oldValue !== undefined &&
        newValue !== undefined &&
        contentHash(oldValue) !== contentHash(newValue)
      ) {
        operations.push(
          makeOperation({ op: 'update', kind, id, before: oldValue, after: newValue, references }),
        );
      }
    }
  }

  const oldProjectMetadata: JsonValue = {
    schema: before.project.schema,
    project_id: before.project.project_id,
    name: before.project.name,
  };

  if (!(before.project.defaults === undefined)) {
    oldProjectMetadata.defaults = before.project.defaults;
  }

  const newProjectMetadata: JsonValue = {
    schema: after.project.schema,
    project_id: after.project.project_id,
    name: after.project.name,
  };

  if (!(after.project.defaults === undefined)) {
    newProjectMetadata.defaults = after.project.defaults;
  }

  if (contentHash(oldProjectMetadata) !== contentHash(newProjectMetadata)) {
    operations.push(
      makeOperation({
        op: 'update',
        kind: 'project',
        id: after.project.project_id,
        before: oldProjectMetadata,
        after: newProjectMetadata,
        references,
      }),
    );
  }

  const attachOperations = references.added
    .filter(({ type }) => type === 'dataset' || type === 'metric')
    .map((reference) => ({
      changes: [],
      op: 'attach' as const,
      references_added: [reference],
      references_removed: [],
      resource: { id: reference.id, type: reference.type },
    }));

  const detachOperations = references.removed
    .filter(({ type }) => type === 'dataset' || type === 'metric')
    .map((reference) => ({
      changes: [],
      op: 'detach' as const,
      references_added: [],
      references_removed: [reference],
      resource: { id: reference.id, type: reference.type },
    }));

  return {
    operations: [...operations, ...attachOperations, ...detachOperations].sort((left, right) =>
      operationKey(left).localeCompare(operationKey(right)),
    ),
    warnings: [...(options.warnings ?? [])],
  };
};

export { createSemanticProjectDiff };
