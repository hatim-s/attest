import * as Data from 'effect/Data';

/**
 * A loopback listener that could not bind, stopped with an error or could not close. `code`
 * keeps the Node.js system code, such as `EADDRINUSE`, and `cause` keeps the original error.
 */
class ViewServerFailure extends Data.TaggedError('ViewServerFailure')<{
  operation: 'listen' | 'close';
  cause: unknown;
  code?: string;
}> {}

export { ViewServerFailure };
