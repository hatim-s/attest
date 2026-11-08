import * as Data from 'effect/Data';

import { foreignMessage } from '@attest/contracts';

/** A tagged failure tests use wherever a host callback, store or foreign call should fail. */
class TestFailure extends Data.TaggedError('TestFailure')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Maps a rejected test promise into the typed failure channel, keeping the rejection as `cause`. */
const toTestFailure = (cause: unknown): TestFailure =>
  new TestFailure({ message: foreignMessage(cause, String(cause)), cause });

export { TestFailure, toTestFailure };
