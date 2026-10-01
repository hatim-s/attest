import { z } from 'zod';

import { attributesSchema } from './otlp-value.js';

const hexIdSchema = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[a-fA-F0-9]{${length}}$`), `must be a ${length}-character hex string`)
    .transform((value) => value.toLowerCase());

/** Converts nanoseconds to the RFC 3339 millisecond precision Attest traces use. */
const timestampSchema = z.union([z.string(), z.number()]).transform((value, context) => {
  if (!/^\d+$/.test(String(value))) {
    context.addIssue({ code: 'custom', message: 'must be an unsigned nanosecond timestamp' });
    return z.NEVER;
  }
  // Values beyond the Date range become NaN here, including ones too large for a safe integer.
  const timestamp = new Date(Number(BigInt(value) / 1_000_000n));
  if (Number.isNaN(timestamp.getTime())) {
    context.addIssue({ code: 'custom', message: 'is outside the Date range' });
    return z.NEVER;
  }
  return timestamp.toISOString();
});

const parentSpanIdSchema = z
  .union([z.literal(''), hexIdSchema(16)])
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value));

const statusSchema = z
  .looseObject({ code: z.unknown(), message: z.string().optional().catch(undefined) })
  .optional()
  .catch(undefined);

const eventSchema = z.looseObject({
  name: z.string().min(1),
  timeUnixNano: timestampSchema,
  attributes: attributesSchema,
});

const otlpSpanSchema = z.looseObject({
  traceId: hexIdSchema(32),
  spanId: hexIdSchema(16),
  parentSpanId: parentSpanIdSchema,
  name: z.string().min(1),
  startTimeUnixNano: timestampSchema,
  endTimeUnixNano: timestampSchema,
  attributes: attributesSchema,
  events: z.array(eventSchema).optional(),
  status: statusSchema,
});

const scopeSchema = z
  .looseObject({
    name: z.string().optional().catch(undefined),
    version: z.string().optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

/**
 * Accepts the subset of an OTLP/HTTP JSON trace export that Attest converts. Objects stay loose
 * because exporters add vendor fields; attribute and scope metadata degrade instead of failing.
 */
const otlpExportSchema = z.looseObject({
  resourceSpans: z.array(
    z.looseObject({
      resource: z.looseObject({ attributes: attributesSchema }).catch({ attributes: {} }),
      scopeSpans: z.array(z.looseObject({ scope: scopeSchema, spans: z.array(otlpSpanSchema) })),
    }),
  ),
});

type OtlpExport = z.infer<typeof otlpExportSchema>;
type OtlpResourceSpans = OtlpExport['resourceSpans'][number];
type OtlpScopeSpans = OtlpResourceSpans['scopeSpans'][number];
type OtlpSpan = z.infer<typeof otlpSpanSchema>;

export { otlpExportSchema, type OtlpScopeSpans, type OtlpSpan };
