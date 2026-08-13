import {
  assertionCheckSchema,
  type AssertionCheck,
  type JsonValue,
  type SecretReference,
} from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import { parseJson, readTextSource, requestDiagnostics } from './source.js';
import type { MetricAddFields } from './types.js';

const parseFiniteNumber = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AttestCliError('cli_usage', `${path} must be a finite number.`, { path });
  }
  return parsed;
};

const parseNonnegativeInteger = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AttestCliError('cli_usage', `${path} must be a non-negative integer.`, { path });
  }
  return parsed;
};

const parseJsonValue = (value: string, path: string): JsonValue =>
  parseJson(value, path, 'Pass one JSON scalar, array, or object.') as JsonValue;

const parseSecretBindings = (
  values: readonly string[] | undefined,
  path: string,
): Record<string, SecretReference> | undefined => {
  if (values === undefined || values.length === 0) return undefined;
  const bindings: Record<string, SecretReference> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const target = value.slice(0, separator).trim();
    const source = value.slice(separator + 1).trim();
    if (separator <= 0 || target.length === 0 || source.length === 0) {
      throw new AttestCliError('cli_usage', `Invalid secret reference in ${path}.`, {
        path,
        hint: 'Use TARGET_NAME=SOURCE_ENV; only the environment variable name is stored.',
      });
    }
    bindings[target] = { from_env: source };
  }
  return bindings;
};

const parsePathValueMatchers = (
  values: readonly string[] | undefined,
  operator: 'contains' | 'equals',
  path: string,
): AssertionCheck[] =>
  (values ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    const matcherPath = entry.slice(0, separator).trim();
    if (separator <= 0 || matcherPath.length === 0) {
      throw new AttestCliError('cli_usage', `Invalid matcher in ${path}.`, {
        path,
        hint: `Use '$.path=<json>' for ${operator} matchers.`,
      });
    }
    const value = parseJsonValue(entry.slice(separator + 1), path);
    return operator === 'equals'
      ? { equals: { path: matcherPath, value } }
      : { contains: { path: matcherPath, value } };
  });

const parseAttributes = (
  values: readonly string[] | undefined,
): Record<string, string | number | boolean> | undefined => {
  if (values === undefined || values.length === 0) return undefined;
  const attributes: Record<string, string | number | boolean> = {};
  for (const entry of values) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator).trim();
    const parsed =
      separator <= 0 ? undefined : parseJsonValue(entry.slice(separator + 1), '--attribute');
    if (
      name.length === 0 ||
      parsed === undefined ||
      (typeof parsed !== 'string' && typeof parsed !== 'number' && typeof parsed !== 'boolean')
    ) {
      throw new AttestCliError('cli_usage', 'Span attributes must use NAME=<json-primitive>.', {
        path: '--attribute',
      });
    }
    attributes[name] = parsed;
  }
  return attributes;
};

const parseAssertionJson = (values: readonly string[]): AssertionCheck[] =>
  values.map((value, index) => {
    const parsed = assertionCheckSchema.safeParse(
      parseJson(value, '--assert-json', 'Pass one assertion check object.'),
    );
    if (!parsed.success) {
      throw new AttestCliError('cli_usage', 'An assertion does not match the metric contract.', {
        path: `--assert-json[${index}]`,
        details: { diagnostics: requestDiagnostics(parsed.error.issues) },
      });
    }
    return parsed.data;
  });

const requireValue = (value: string | undefined, path: string): string => {
  if (value?.trim()) return value.trim();
  throw new AttestCliError('cli_missing_input', `Required metric input ${path} is missing.`, {
    path,
    hint: `Pass ${path}, use the guided wizard, or provide a complete --from-json request.`,
  });
};

const readExclusiveText = async (
  literal: string | undefined,
  source: string | undefined,
  literalPath: string,
  sourcePath: string,
  fields: MetricAddFields,
): Promise<string> => {
  if (literal !== undefined && source !== undefined) {
    throw new AttestCliError('cli_usage', 'Metric text input sources overlap.', {
      path: literalPath,
      hint: `Pass either ${literalPath} or ${sourcePath}.`,
    });
  }
  if (literal?.trim()) return literal.trim();
  if (source !== undefined) {
    const text = await readTextSource(
      source,
      sourcePath,
      fields.workingDirectory,
      fields.readStdin,
    );
    if (text.trim()) return text;
  }
  throw new AttestCliError(
    'cli_missing_input',
    `Required metric input ${literalPath} is missing.`,
    {
      path: literalPath,
      hint: `Pass ${literalPath} or ${sourcePath}.`,
    },
  );
};

export {
  parseAssertionJson,
  parseAttributes,
  parseFiniteNumber,
  parseJsonValue,
  parseNonnegativeInteger,
  parsePathValueMatchers,
  parseSecretBindings,
  readExclusiveText,
  requireValue,
};
