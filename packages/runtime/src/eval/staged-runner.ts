import type { CaseEnvironment, CaseExecution } from '@attest/executor';

import type { MetricEvaluation } from '../metrics/metric-evaluation.js';
import type { EvalCaseRunner, ResolvedEvalCase } from './types.js';

type CaseStageContext<Payload> = {
  runId: string;
  resolvedCase: ResolvedEvalCase<Payload>;
  signal: AbortSignal;
  worker_index: number;
  environment?: CaseEnvironment;
};
type StagedCaseRunnerOptions<Payload> = {
  invoke(context: CaseStageContext<Payload>): Promise<CaseExecution>;
  evaluate(
    context: CaseStageContext<Payload> & { execution: CaseExecution },
  ): Promise<readonly MetricEvaluation[]>;
};
type EvalCaseStage = 'after_agent' | 'after_evaluation';

/** Retains completed stage evidence when a lifecycle hook stops the remaining case work. */
class EvalCaseStageError extends Error {
  constructor(
    readonly stage: EvalCaseStage,
    readonly execution: CaseExecution,
    readonly metrics: readonly MetricEvaluation[],
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : `Eval ${stage} hook failed.`;
    super(detail, { cause });
    this.name = 'EvalCaseStageError';
  }
}

/** Runs injected agent and evaluation code with the same case environment and awaited stage hooks. */
const createStagedCaseRunner = <Payload>(
  options: StagedCaseRunnerOptions<Payload>,
): EvalCaseRunner<Payload> => ({
  executeCase: async (runId, resolvedCase, signal, worker) => {
    const context = {
      runId,
      resolvedCase,
      signal,
      worker_index: worker.worker_index,
      environment: worker.environment,
    };
    const execution = await options.invoke(context);
    try {
      await worker.afterAgent?.(execution);
    } catch (error: unknown) {
      throw new EvalCaseStageError('after_agent', execution, [], error);
    }
    const metrics = await options.evaluate({ ...context, execution });
    try {
      await worker.afterEvaluation?.(execution, metrics);
    } catch (error: unknown) {
      throw new EvalCaseStageError('after_evaluation', execution, metrics, error);
    }
    return { execution, metrics };
  },
});

export {
  createStagedCaseRunner,
  EvalCaseStageError,
  type CaseStageContext,
  type EvalCaseStage,
  type StagedCaseRunnerOptions,
};
