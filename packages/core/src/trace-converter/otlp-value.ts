type AttributeValue = string | number | boolean;

type OtlpAnyValue = {
  boolValue?: unknown;
  bytesValue?: unknown;
  doubleValue?: unknown;
  intValue?: unknown;
  stringValue?: unknown;
};

/** Converts scalar OTLP AnyValue encodings without losing unsafe 64-bit integers. */
const fromOtlpAnyValue = (candidate: unknown): AttributeValue | undefined => {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const value = candidate as OtlpAnyValue;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) {
    return value.doubleValue;
  }
  if (typeof value.intValue === 'number' && Number.isSafeInteger(value.intValue)) {
    return value.intValue;
  }
  if (typeof value.intValue === 'string' && /^-?\d+$/.test(value.intValue)) {
    const parsed = Number(value.intValue);
    return Number.isSafeInteger(parsed) ? parsed : value.intValue;
  }
  if (typeof value.bytesValue === 'string') return value.bytesValue;
  return undefined;
};

/** Flattens an OTLP KeyValue array into the scalar attribute surface supported by Attest. */
const fromOtlpAttributes = (candidate: unknown): Record<string, AttributeValue> => {
  if (!Array.isArray(candidate)) return {};
  const attributes: Record<string, AttributeValue> = {};
  for (const entry of candidate) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    const converted = fromOtlpAnyValue(value);
    if (typeof key === 'string' && converted !== undefined) attributes[key] = converted;
  }
  return attributes;
};

export { fromOtlpAnyValue, fromOtlpAttributes, type AttributeValue };
