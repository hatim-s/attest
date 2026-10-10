import assert from 'node:assert/strict';

import { cliResultSchema, isJsonValue, type JsonValue } from '../packages/contracts/src/index.js';

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  files: string[];
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PackedArchive = { filename: string; files: { path: string }[] };

const isString = (value: unknown): value is string => typeof value === 'string';

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringRecord = (value: JsonValue): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isString);

const isExportRecord = (
  value: JsonValue,
): value is Manifest['exports'] & { [key: string]: JsonValue } =>
  isRecord(value) &&
  Object.values(value).every((entry) => isString(entry) || isStringRecord(entry));

/** Decodes release tool JSON before inspecting its metadata or result fields. */
const parseJson = (source: string): JsonValue => {
  const value: unknown = JSON.parse(source);
  assert(isJsonValue(value), 'Expected valid JSON metadata.');

  return value;
};

/** Validates the package fields used to construct a published release archive. */
const parseManifest = (source: string): Manifest => {
  const value = parseJson(source);
  assert(isRecord(value), 'Expected package metadata.');
  assert(isString(value.name) && isString(value.version), 'Expected package name and version.');
  assert(
    Array.isArray(value.files) && value.files.every(isString),
    'Expected published file paths.',
  );
  const manifest: Manifest = { name: value.name, version: value.version, files: value.files };

  if (value.private !== undefined) {
    assert(isBoolean(value.private), 'Expected package private flag.');
    manifest.private = value.private;
  }

  if (value.exports !== undefined) {
    assert(isExportRecord(value.exports), 'Expected package export paths.');
    manifest.exports = value.exports;
  }

  for (const key of [
    'dependencies',
    'optionalDependencies',
    'devDependencies',
    'scripts',
  ] as const) {
    const field = value[key];

    if (field !== undefined) {
      assert(isStringRecord(field), `Expected string-valued package ${key}.`);
      manifest[key] = field;
    }
  }

  return manifest;
};

/** Validates npm pack's archive list before checking the published file set. */
const parsePackedArchives = (source: string): PackedArchive[] => {
  const values = parseJson(source);
  assert(Array.isArray(values), 'Expected npm pack archive list.');

  return values.map((value) => {
    assert(isRecord(value) && isString(value.filename) && Array.isArray(value.files));

    const files = value.files.map((file) => {
      assert(isRecord(file) && isString(file.path), 'Expected npm pack file path.');

      return { path: file.path };
    });

    return { filename: value.filename, files };
  });
};

/** Reads the CLI's versioned result envelope during release verification. */
const parseCliResult = (source: string) => cliResultSchema.parse(JSON.parse(source));

export { isRecord, isString, parseCliResult, parseManifest, parsePackedArchives };

export type { Manifest };
