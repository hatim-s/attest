type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => value as JsonObject;

/** Walks a generated schema and adds the threshold comparison invariant. */
const addThresholdInvariant = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(addThresholdInvariant);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }

  const object = asObject(value);
  const properties = object.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const propertyNames = Object.keys(asObject(properties));
    if (['lt', 'lte', 'gt', 'gte'].every((name) => propertyNames.includes(name))) {
      object.anyOf = [
        { required: ['lt'] },
        { required: ['lte'] },
        { required: ['gt'] },
        { required: ['gte'] },
      ];
    }
  }

  Object.values(object).forEach(addThresholdInvariant);
};

/** Adds cross-field invariants that are representable in JSON Schema. */
const postProcessJsonSchema = (schema: JsonObject, fileName: string): JsonObject => {
  if (fileName === 'agent-response.v1alpha1.json') {
    schema.oneOf = [
      { required: ['output'], not: { required: ['error'] } },
      { required: ['error'], not: { required: ['output'] } },
    ];
  }

  if (fileName === 'config.v1.json') {
    const properties = asObject(schema.properties);
    const suites = asObject(properties.suites);
    const suite = asObject(suites.items);
    suite.oneOf = [
      { required: ['cases'], not: { required: ['dataset'] } },
      { required: ['dataset'], not: { required: ['cases'] } },
    ];

    const metrics = asObject(properties.metrics);
    const metricItems = asObject(metrics.items);
    const metricVariants = metricItems.oneOf as unknown[];
    const executable = metricVariants.find((variant) => {
      const variantProperties = asObject(asObject(variant).properties);
      return asObject(variantProperties.type).const === 'exec';
    });
    if (executable) {
      asObject(executable).oneOf = [
        { required: ['command'], not: { required: ['url'] } },
        { required: ['url'], not: { required: ['command'] } },
      ];
    }

    addThresholdInvariant(schema);
  }

  schema.$comment =
    'Not expressible here: span time ordering, duplicate-id checks, and metric name references.';
  return schema;
};

export { postProcessJsonSchema };
