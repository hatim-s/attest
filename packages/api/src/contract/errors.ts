import { runStartDiagnosticsSchema } from '@attest/core/records';
import { z } from 'zod';

const API_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_CURSOR',
  'FORBIDDEN',
  'ROUTE_NOT_FOUND',
  'RUN_NOT_FOUND',
  'CASE_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'RUN_START_FAILED',
  'CONTROL_UNAVAILABLE',
  'SOURCE_UNREADABLE',
  'INTERNAL_ERROR',
] as const;

const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** The CLI's diagnostics for RUN_START_FAILED. */
    details: runStartDiagnosticsSchema.optional(),
  }),
});

type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

const API_ERROR_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_CURSOR: 400,
  FORBIDDEN: 403,
  ROUTE_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  CASE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  RUN_START_FAILED: 422,
  CONTROL_UNAVAILABLE: 501,
  SOURCE_UNREADABLE: 500,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ApiErrorCode, number>;

export {
  API_ERROR_CODES,
  apiErrorEnvelopeSchema,
  API_ERROR_STATUS,
  type ApiErrorCode,
  type ApiErrorEnvelope,
};
