export {
  convertOtlpJson,
  inferSpanKind,
  nanosecondsToTimestamp,
  normalizeGenAiAttributes,
  selectConvertedTrace,
} from './otlp-json.js';
export { TraceConversionError } from './types.js';
export type { ConvertOtlpJsonOptions, TraceConversionErrorCode } from './types.js';
