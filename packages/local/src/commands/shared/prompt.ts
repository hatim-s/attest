import type * as Effect from 'effect/Effect';

import type { LocalError } from '../../errors/index.js';

/**
 * Asks one terminal question. The host owns cancellation: a cancelled question fails with a
 * `cancelled` LocalError, and an unexpected terminal failure is a defect.
 */
type Prompt = (question: string) => Effect.Effect<string, LocalError>;

export { type Prompt };
