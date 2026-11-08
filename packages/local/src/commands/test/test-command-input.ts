import * as Effect from 'effect/Effect';

import { parseJsonText } from '../../internal/source-text.js';

/** Parses one JSON-valued flag without reflecting its authored value into errors. */
const parseJsonFlag = Effect.fn('parseJsonFlag')(function* (value: string, path: string) {
  return yield* parseJsonText(value, { path, hint: 'Pass a JSON scalar, array, or object.' });
});

export { parseJsonFlag };
