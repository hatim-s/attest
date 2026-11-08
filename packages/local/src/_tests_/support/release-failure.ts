import * as Data from 'effect/Data';

/** A typed release failure for cleanup precedence fixtures; assertions read only its message. */
class ReleaseFailure extends Data.TaggedError('ReleaseFailure')<{ readonly message: string }> {}

export { ReleaseFailure };
