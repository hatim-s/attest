import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type { EvalCaseRunnerResult } from './types.js';

/** Internal receipts retain full Causes without putting callback details into public results. */
class EvalLifecycleEvidence extends Context.Service<
  EvalLifecycleEvidence,
  { causes: readonly Cause.Cause<Error>[]; completed?: unknown }
>()('attest/EvalLifecycleEvidence') {}

/** Observes each callback once; the owner decides which operational errors become evidence. */
const observe = <A>(operation: () => Effect.Effect<A, Error>) =>
  Effect.exit(Effect.suspend(operation));

/** Extracts only a single ordinary failure. Mixed Causes must propagate intact. */
const ordinaryError = (cause: Cause.Cause<Error>): Error | undefined => {
  if (cause.reasons.length !== 1) return undefined;

  if (
    cause.reasons.some((reason) =>
      Context.getOrUndefined(Cause.reasonAnnotations(reason), EvalLifecycleEvidence)?.causes.some(
        (c) => Cause.hasDies(c) || Cause.hasInterrupts(c) || c.reasons.length > 1,
      ),
    )
  )
    return undefined;
  const reason = cause.reasons[0];

  return reason !== undefined && Cause.isFailReason(reason) ? reason.error : undefined;
};

/** Adds release receipts to the primary Cause while preserving every earlier annotation. */
const withEvidence = <E, A = never>(
  cause: Cause.Cause<E>,
  causes: readonly Cause.Cause<Error>[],
  completed?: A,
) => {
  const previous = cause.reasons.flatMap(
    (reason) =>
      Context.getOrUndefined(Cause.reasonAnnotations(reason), EvalLifecycleEvidence)?.causes ?? [],
  );

  return Cause.annotate(
    cause,
    Context.make(EvalLifecycleEvidence, {
      causes: [...previous, ...causes],
      completed,
    }),
    { overwrite: true },
  );
};

/** Projects ordinary errors for diagnostics while keeping nonordinary Causes out of wire data. */
const exitError = (exit: Exit.Failure<unknown, Error>): Error =>
  ordinaryError(exit.cause) ?? new Error('Eval callback did not complete normally.');

const receipts = new WeakMap<EvalCaseRunnerResult, readonly Cause.Cause<Error>[]>();

/** Stores internal case receipts without changing persisted evidence or retaining completed cases globally. */
const retainCauses = <A extends EvalCaseRunnerResult>(
  value: A,
  causes: readonly Cause.Cause<Error>[],
): A => {
  receipts.set(value, causes);

  return value;
};

/** Reads receipts while the scheduler still owns the completed case object. */
const retainedCauses = (value: EvalCaseRunnerResult) => receipts.get(value) ?? [];

export {
  retainCauses,
  retainedCauses,
  EvalLifecycleEvidence,
  observe,
  ordinaryError,
  withEvidence,
  exitError,
};
