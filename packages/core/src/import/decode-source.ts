import { importDiagnostic } from './import-diagnostics.js';
import type { ImportDiagnostic } from './import-types.js';

interface DecodedSource {
  bytes: Uint8Array;
  diagnostics: ImportDiagnostic[];
  text: string;
}

/** Decodes strict UTF-8 and drops a leading byte-order mark; invalid bytes become a diagnostic. */
const decodeSource = (source: string | Uint8Array): DecodedSource => {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const diagnostic = importDiagnostic({
      code: 'invalid_utf8',
      message: 'Import source is not valid UTF-8.',
      hint: 'Re-encode the complete source as UTF-8 and retry.',
    });
    return { bytes, diagnostics: [diagnostic], text: '' };
  }
  const text = decoded.startsWith('﻿') ? decoded.slice(1) : decoded;
  return { bytes, diagnostics: [], text };
};

export { decodeSource };
