import type { ProjectResources } from '@attest/contracts';

import { hashCanonicalJson, type JsonValue } from '../canonical-project.js';
import type { LoadedProject } from '../load-project.js';
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

const escapePointerSegment = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

/** Produces deterministic field-level changes without including authored values. */
const diffJsonFields = (before: JsonValue, after: JsonValue, path = ''): SemanticFieldChange[] => {
  if (Object.is(before, after)) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
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
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const beforeRecord = before as Record<string, JsonValue>;
    const afterRecord = after as Record<string, JsonValue>;
    return [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
      .sort()
      .flatMap((key) => {
        const childPath = `${path}/${escapePointerSegment(key)}`;
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
  });
  return references.sort((left, right) =>
    `${left.path}:${left.type}:${left.id}`.localeCompare(`${right.path}:${right.type}:${right.id}`),
  );
};

const referenceKey = ({ id, path, type }: SemanticReference): string => `${type}:${id}:${path}`;

const diffReferences = (
  before: ProjectResources,
  after: ProjectResources,
): { added: SemanticReference[]; removed: SemanticReference[] } => {
  const oldReferences = referencesForProject(before);
  const newReferences = referencesForProject(after);
  const oldKeys = new Set(oldReferences.map(referenceKey));
  const newKeys = new Set(newReferences.map(referenceKey));
  return {
    added: newReferences.filter((reference) => !oldKeys.has(referenceKey(reference))),
    removed: oldReferences.filter((reference) => !newKeys.has(referenceKey(reference))),
  };
};

const valuesByKind = (
  project: ProjectResources,
  kind: Exclude<ProjectResourceKind, 'project'>,
): ReadonlyMap<string, ResourceValue> => {
  const values =
    kind === 'agent'
      ? project.agents
      : kind === 'test'
        ? project.tests
        : kind === 'metric'
          ? project.metrics
          : project.datasets.map(({ cases, metadata }) => ({ ...metadata, cases }));
  return new Map(values.map((value) => [value.id, value as ResourceValue]));
};

const referencesForResource = (
  references: readonly SemanticReference[],
  kind: ProjectResourceKind,
  id: string,
): SemanticReference[] =>
  references.filter((reference) =>
    kind === 'test' ? reference.path.startsWith(`/tests/${id}/`) : reference.id === id,
  );

const makeOperation = (
  op: SemanticProjectOperation['op'],
  kind: ProjectResourceKind,
  id: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  addedReferences: readonly SemanticReference[],
  removedReferences: readonly SemanticReference[],
  previousId?: string,
): SemanticProjectOperation => ({
  changes:
    before === undefined || after === undefined ? [] : diffJsonFields(before, after).sort(byPath),
  ...(after === undefined ? {} : { new_content_hash: hashCanonicalJson(after) }),
  ...(before === undefined ? {} : { old_content_hash: hashCanonicalJson(before) }),
  op,
  ...(previousId === undefined ? {} : { previous_id: previousId }),
  references_added: referencesForResource(addedReferences, kind, id),
  references_removed: referencesForResource(removedReferences, kind, previousId ?? id),
  resource: { id, type: kind },
});

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
        'candidate_invalid',
        'Rename hint does not match candidate.',
        {
          rename,
        },
      );
    }
    renameKeys.add(`${rename.type}:${rename.from}`);
    renameKeys.add(`${rename.type}:${rename.to}`);
    operations.push(
      makeOperation(
        'rename',
        rename.type,
        rename.to,
        oldValue,
        newValue,
        references.added,
        references.removed,
        rename.from,
      ),
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
        operations.push(
          makeOperation('add', kind, id, undefined, newValue, references.added, references.removed),
        );
      } else if (oldValue !== undefined && newValue === undefined) {
        operations.push(
          makeOperation(
            'remove',
            kind,
            id,
            oldValue,
            undefined,
            references.added,
            references.removed,
          ),
        );
      } else if (
        oldValue !== undefined &&
        newValue !== undefined &&
        hashCanonicalJson(oldValue) !== hashCanonicalJson(newValue)
      ) {
        operations.push(
          makeOperation(
            'update',
            kind,
            id,
            oldValue,
            newValue,
            references.added,
            references.removed,
          ),
        );
      }
    }
  }

  const oldProjectMetadata: JsonValue = {
    schema: before.project.schema,
    project_id: before.project.project_id,
    name: before.project.name,
    ...(before.project.defaults === undefined ? {} : { defaults: before.project.defaults }),
  };
  const newProjectMetadata: JsonValue = {
    schema: after.project.schema,
    project_id: after.project.project_id,
    name: after.project.name,
    ...(after.project.defaults === undefined ? {} : { defaults: after.project.defaults }),
  };
  if (hashCanonicalJson(oldProjectMetadata) !== hashCanonicalJson(newProjectMetadata)) {
    operations.push(
      makeOperation(
        'update',
        'project',
        after.project.project_id,
        oldProjectMetadata,
        newProjectMetadata,
        references.added,
        references.removed,
      ),
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

export { createSemanticProjectDiff, diffJsonFields };
