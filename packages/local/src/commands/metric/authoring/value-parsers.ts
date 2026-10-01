import {
  assertionCheckSchema,
  type AssertionCheck,
  type JsonValue,
  type SecretReference,
  type ToolArgumentMatcher,
} from '@attest/contracts';
import { z } from 'zod';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonText, readSourceText } from '../../../internal/source-text.js';
import { parseSecretBindings } from '../../shared/secret-bindings.js';
import type { MetricAddFields } from './types.js';

const parseFiniteNumber = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LocalError('cli_usage', `${path} must be a finite number.`, { path });
  }
  return parsed;
};

/** Parses a flag limited to fixed values into its literal type, or rejects it as a usage error. */
const parseChoice = <const Choice extends string>(
  value: string,
  choices: readonly [Choice, ...Choice[]],
  path: string,
): Choice => {
  const parsed = z.enum(choices).safeParse(value);
  if (!parsed.success) {
    throw new LocalError('cli_usage', `${path} must be one of ${choices.join(', ')}.`, { path });
  }
  return parsed.data;
};

const parseNonnegativeInteger = (value: string, path: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new LocalError('cli_usage', `${path} must be a non-negative integer.`, { path });
  }
  return parsed;
};

const parseJsonValue = (value: string, path: string): JsonValue =>
  parseJsonText(value, { path, hint: 'Pass one JSON scalar, array, or object.' });

/** Parses secret binding flags, returning undefined when none were passed so the field is omitted. */
const parseOptionalSecretBindings = (
  values: readonly string[] | undefined,
  path: string,
): Record<string, SecretReference> | undefined =>
  values === undefined || values.length === 0 ? undefined : parseSecretBindings(values, path);

const parsePathValueMatchers = (
  values: readonly string[] | undefined,
  operator: 'contains' | 'equals',
  path: string,
): ToolArgumentMatcher[] =>
  (values ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    const matcherPath = entry.slice(0, separator).trim();
    if (separator <= 0 || matcherPath.length === 0) {
      throw new LocalError('cli_usage', `Invalid matcher in ${path}.`, {
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
      throw new LocalError('cli_usage', 'Span attributes must use NAME=<json-primitive>.', {
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
      parseJsonText(value, { path: '--assert-json', hint: 'Pass one assertion check object.' }),
    );
    if (!parsed.success) {
      throw new LocalError('cli_usage', 'An assertion does not match the metric contract.', {
        path: `--assert-json[${index}]`,
        details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
      });
    }
    return parsed.data;
  });

const requireValue = (value: string | undefined, path: string): string => {
  if (value?.trim()) return value.trim();
  throw new LocalError('cli_missing_input', `Required metric input ${path} is missing.`, {
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
    throw new LocalError('cli_usage', 'Metric text input sources overlap.', {
      path: literalPath,
      hint: `Pass either ${literalPath} or ${sourcePath}.`,
    });
  }
  if (literal?.trim()) return literal.trim();
  if (source !== undefined) {
    const text = await readSourceText(source, {
      path: sourcePath,
      readStdin: fields.readStdin,
      workingDirectory: fields.workingDirectory,
    });
    if (text.trim()) return text;
  }
  throw new LocalError('cli_missing_input', `Required metric input ${literalPath} is missing.`, {
    path: literalPath,
    hint: `Pass ${literalPath} or ${sourcePath}.`,
  });
};

export {
  parseAssertionJson,
  parseAttributes,
  parseChoice,
  parseFiniteNumber,
  parseJsonValue,
  parseNonnegativeInteger,
  parsePathValueMatchers,
  parseOptionalSecretBindings,
  readExclusiveText,
  requireValue,
};
