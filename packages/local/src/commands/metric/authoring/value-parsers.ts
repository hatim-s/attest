import * as Effect from 'effect/Effect';
import {
  parseWithSchema,
  assertionCheckSchema,
  type AssertionCheck,
  type ToolArgumentMatcher,
} from '@attest/contracts';
import * as Schema from 'effect/Schema';

import { LocalError } from '../../../errors/index.js';
import { schemaIssueDiagnostics } from '../../../internal/schema-issue-diagnostics.js';
import { parseJsonTextEffect, readSourceText } from '../../../internal/source-text.js';
import { parseSecretBindingsEffect } from '../../shared/secret-bindings.js';
import type { MetricAddFields } from './types.js';

const attributeValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

const parseFiniteNumber = Effect.fn('parseFiniteNumber')(function* (value: string, path: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return yield* new LocalError('cli_usage', `${path} must be a finite number.`, { path });
  }

  return parsed;
});

/** Parses a flag limited to fixed values into its literal type, or rejects it as a usage error. */
const parseChoice = Effect.fn('parseChoice')(function* <const Choice extends string>(
  value: string,
  choices: readonly [Choice, ...Choice[]],
  path: string,
) {
  const parsed = parseWithSchema(Schema.Literals(choices), value);

  if (!parsed.ok) {
    return yield* new LocalError('cli_usage', `${path} must be one of ${choices.join(', ')}.`, {
      path,
    });
  }

  return parsed.value;
});

const parseNonnegativeInteger = Effect.fn('parseNonnegativeInteger')(function* (
  value: string,
  path: string,
) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return yield* new LocalError('cli_usage', `${path} must be a non-negative integer.`, { path });
  }

  return parsed;
});

const parseJsonValue = Effect.fn('parseJsonValue')(function* (value: string, path: string) {
  return yield* parseJsonTextEffect(value, {
    path,
    hint: 'Pass one JSON scalar, array, or object.',
  });
});

/** Parses secret binding flags, returning undefined when none were passed so the field is omitted. */
const parseOptionalSecretBindings = Effect.fn('parseOptionalSecretBindings')(function* (
  values: readonly string[] | undefined,
  path: string,
) {
  return values === undefined || values.length === 0
    ? undefined
    : yield* parseSecretBindingsEffect(values, path);
});

const parsePathValueMatchers = Effect.fn('parsePathValueMatchers')(function* (
  values: readonly string[] | undefined,
  operator: 'contains' | 'equals',
  path: string,
) {
  const matchers: ToolArgumentMatcher[] = [];

  for (const entry of values ?? []) {
    const separator = entry.indexOf('=');
    const matcherPath = entry.slice(0, separator).trim();

    if (separator <= 0 || matcherPath.length === 0) {
      return yield* new LocalError('cli_usage', `Invalid matcher in ${path}.`, {
        path,
        hint: `Use '$.path=<json>' for ${operator} matchers.`,
      });
    }

    const value = yield* parseJsonValue(entry.slice(separator + 1), path);

    matchers.push(
      operator === 'equals'
        ? { equals: { path: matcherPath, value } }
        : { contains: { path: matcherPath, value } },
    );
  }

  return matchers;
});

// BOUNDARY: CLI attribute text is decoded as JSON and accepted only when it represents a string, finite number or boolean.
const parseAttributes = Effect.fn('parseAttributes')(function* (
  values: readonly string[] | undefined,
) {
  if (values === undefined || values.length === 0) return undefined;
  const attributes: Record<string, string | number | boolean> = {};

  for (const entry of values) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator).trim();

    const parsed =
      separator <= 0 ? undefined : yield* parseJsonValue(entry.slice(separator + 1), '--attribute');

    const attribute =
      parsed === undefined ? undefined : parseWithSchema(attributeValueSchema, parsed);

    if (name.length === 0 || attribute === undefined || !attribute.ok) {
      return yield* new LocalError('cli_usage', 'Span attributes must use NAME=<json-primitive>.', {
        path: '--attribute',
      });
    }

    attributes[name] = attribute.value;
  }

  return attributes;
});

const parseAssertionJson = Effect.fn('parseAssertionJson')(function* (values: readonly string[]) {
  const assertions: AssertionCheck[] = [];

  for (const [index, value] of values.entries()) {
    const parsed = parseWithSchema(
      assertionCheckSchema,
      yield* parseJsonTextEffect(value, {
        path: '--assert-json',
        hint: 'Pass one assertion check object.',
      }),
    );

    if (!parsed.ok) {
      return yield* new LocalError(
        'cli_usage',
        'An assertion does not match the metric contract.',
        {
          path: `--assert-json[${index}]`,
          details: { diagnostics: schemaIssueDiagnostics(parsed.error.issues) },
        },
      );
    }

    assertions.push(parsed.value);
  }

  return assertions;
});

const requireValue = Effect.fn('requireValue')(function* (value: string | undefined, path: string) {
  if (value?.trim()) return value.trim();

  return yield* new LocalError('cli_missing_input', `Required metric input ${path} is missing.`, {
    path,
    hint: `Pass ${path}, use the guided wizard, or provide a complete --from-json request.`,
  });
});

const readExclusiveText = Effect.fn('readExclusiveText')(function* (
  literal: string | undefined,
  source: string | undefined,
  literalPath: string,
  sourcePath: string,
  fields: MetricAddFields,
) {
  if (literal !== undefined && source !== undefined) {
    return yield* new LocalError('cli_usage', 'Metric text input sources overlap.', {
      path: literalPath,
      hint: `Pass either ${literalPath} or ${sourcePath}.`,
    });
  }

  if (literal?.trim()) return literal.trim();

  if (source !== undefined) {
    const text = yield* readSourceText(source, {
      path: sourcePath,
      readStdin: fields.readStdin,
      workingDirectory: fields.workingDirectory,
    });

    if (text.trim()) return text;
  }

  return yield* new LocalError(
    'cli_missing_input',
    `Required metric input ${literalPath} is missing.`,
    {
      path: literalPath,
      hint: `Pass ${literalPath} or ${sourcePath}.`,
    },
  );
});

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
