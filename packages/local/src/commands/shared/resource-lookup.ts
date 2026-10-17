import { LocalError } from '../../errors/index.js';

/** The label each lookup error names and the command that lists the available ids. */
const RESOURCE_LOOKUPS = {
  agent: { label: 'Agent', hint: 'Run `attest list agents` to inspect available ids.' },
  case: {
    label: 'Case',
    hint: 'Run `attest test case list <test-id>` to inspect direct case ids.',
  },
  dataset: { label: 'Dataset', hint: 'Run `attest list datasets` to inspect available ids.' },
  metric: { label: 'Metric', hint: 'Run `attest list metrics` to inspect available ids.' },
  run: { label: 'Run', hint: 'Run `attest list runs` to inspect available ids.' },
  test: { label: 'Test', hint: 'Run `attest list tests` to inspect available ids.' },
} as const;

type ResourceType = keyof typeof RESOURCE_LOOKUPS;

/** Builds the one not-found error every command reports for a missing id. */
const missingResource = (type: ResourceType, id: string): LocalError =>
  new LocalError('resource_not_found', `${RESOURCE_LOOKUPS[type].label} ${id} was not found.`, {
    path: id,
    hint: RESOURCE_LOOKUPS[type].hint,
  });

/** Finds one resource by id, so every command reports a missing id the same way. */
const findResource = <Resource extends { id: string }>(
  type: ResourceType,
  resources: readonly Resource[],
  id: string,
): Resource => {
  const resource = resources.find((candidate) => candidate.id === id);

  if (resource === undefined) throw missingResource(type, id);

  return resource;
};

/** Rejects an add, import or rename whose target id is already taken. */
const assertNewId = (type: ResourceType, resources: readonly { id: string }[], id: string) => {
  if (resources.some((resource) => resource.id === id)) {
    throw new LocalError(
      'project_invalid',
      `${RESOURCE_LOOKUPS[type].label} ${id} already exists.`,
      {
        path: id,
        hint: `Choose a new ${type} id.`,
      },
    );
  }
};

export { assertNewId, findResource, missingResource };
