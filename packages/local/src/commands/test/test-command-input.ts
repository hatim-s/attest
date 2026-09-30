import type { JsonValue } from '@attest/contracts';

import { parseJsonText } from '../../internal/source-text.js';

/** Parses one optional JSON-valued flag without reflecting its authored value into errors. */
const parseJsonFlag = (value: string | undefined, path: string): JsonValue | undefined => {
  if (value === undefined) return undefined;
  return parseJsonText(value, { path, hint: 'Pass a JSON scalar, array, or object.' });
};

export { parseJsonFlag };
