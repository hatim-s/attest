import { monotonicFactory } from 'ulid';

/**
 * Generates ULIDs for runs, cases, and metric rows. One shared monotonic factory keeps ids
 * strictly increasing within a millisecond across every table in the process.
 */
const createUlid = monotonicFactory();

export { createUlid };
