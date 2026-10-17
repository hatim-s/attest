import { isBoolean, isJsonObject, isJsonValue, isString, type JsonValue } from '@attest/contracts';

const dependencyEntries = (value: JsonValue | undefined): Record<string, string> | undefined => {
  if (value === undefined) return undefined;

  if (!isJsonObject(value)) throw new Error('Package dependencies must be an object.');

  return Object.fromEntries(
    Object.entries(value).map(([name, range]) => {
      if (!isString(range)) throw new Error(`Dependency ${name} must have a string range.`);

      return [name, range] as const;
    }),
  );
};

const peerMetadata = (value: JsonValue | undefined) => {
  if (value === undefined) return undefined;

  if (!isJsonObject(value)) throw new Error('Package peer dependency metadata must be an object.');

  return Object.fromEntries(
    Object.entries(value).map(([name, metadata]) => {
      if (
        !isJsonObject(metadata) ||
        (metadata.optional !== undefined && !isBoolean(metadata.optional))
      ) {
        throw new Error(`Peer dependency ${name} has invalid optional metadata.`);
      }

      return [name, { optional: metadata.optional }] as const;
    }),
  );
};

/** The materializer reads workspace and third-party manifests, so neither shape is trusted. */
const parsePackageManifest = (text: string) => {
  const value: unknown = JSON.parse(text);

  if (!isJsonValue(value) || !isJsonObject(value) || !isString(value.name)) {
    throw new Error('Package manifest must have a string name.');
  }

  return {
    name: value.name,
    dependencies: dependencyEntries(value.dependencies),
    optionalDependencies: dependencyEntries(value.optionalDependencies),
    peerDependencies: dependencyEntries(value.peerDependencies),
    peerDependenciesMeta: peerMetadata(value.peerDependenciesMeta),
  };
};

export { parsePackageManifest };
