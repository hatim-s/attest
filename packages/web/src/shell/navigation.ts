import * as Schema from 'effect/Schema';
import type { ApiCapabilities } from '@attest/api/contract';
import type { ProjectRecord } from '@attest/core/records';

const identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => value.trim().length > 0),
);

const projectScope = { sourceId: identity, projectKey: identity };

const scope = { ...projectScope, evalId: identity };

const recentTargetSchema = Schema.Union([
  Schema.Struct({ ...projectScope, kind: Schema.Literal('project-run'), runId: identity }),
  Schema.Struct({
    ...scope,
    kind: Schema.Literal('project-run-case'),
    runId: identity,
    caseId: identity,
  }),
  Schema.Struct({ ...scope, kind: Schema.Literal('run'), runId: identity }),
  Schema.Struct({ ...scope, kind: Schema.Literal('case'), caseId: identity }),
  Schema.Struct({ ...scope, kind: Schema.Literal('run-case'), runId: identity, caseId: identity }),
]);

type RecentTarget = typeof recentTargetSchema.Type;

type ShellTarget =
  | { kind: 'projects'; sourceId: string }
  | { kind: 'project' | 'project-runs'; sourceId: string; projectKey: string }
  | { kind: 'runs' | 'cases'; sourceId: string; projectKey: string; evalId: string }
  | RecentTarget;

type ShellSource = {
  /** Stable non-secret identity. Include account/workspace scope when applicable. */
  id: string;
  label: string;
} & (
  | { kind: 'local' | 'cloud'; capabilities: ApiCapabilities }
  | { kind: 'report'; capabilities: { control: false } }
);

/** `failing` follows the eval's last terminal verdict; `running` wins while a slice executes. */
type ShellEval = { id: string; name: string; mark: 'failing' | 'running' | null };

/** Load only the expanded project's evals; terminal states never announce loading. */
type NavigationData<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry?: () => void }
  | { status: 'unavailable'; message: string }
  | { status: 'ready'; items: readonly T[] };

/** `failing` marks a collapsed project when any of its evals is failing. */
type ShellProject = Pick<ProjectRecord, 'key' | 'name'> & { failing: boolean };

type ShellBreadcrumb = { label: string; target: ShellTarget };

type RecentLabel = { label: string; context: string };

/** Tuple encoding keeps delimiters in opaque domain identifiers unambiguous. */
const targetKey = (target: ShellTarget): string => {
  switch (target.kind) {
    case 'projects':
      return JSON.stringify([target.kind, target.sourceId]);
    case 'project':
    case 'project-runs':
      return JSON.stringify([target.kind, target.sourceId, target.projectKey]);
    case 'runs':
    case 'cases':
      return JSON.stringify([target.kind, target.sourceId, target.projectKey, target.evalId]);
    case 'project-run':
      return JSON.stringify([target.kind, target.sourceId, target.projectKey, target.runId]);
    case 'project-run-case':
      return JSON.stringify([
        target.kind,
        target.sourceId,
        target.projectKey,
        target.evalId,
        target.runId,
        target.caseId,
      ]);
    case 'run':
      return JSON.stringify([
        target.kind,
        target.sourceId,
        target.projectKey,
        target.evalId,
        target.runId,
      ]);
    case 'case':
      return JSON.stringify([
        target.kind,
        target.sourceId,
        target.projectKey,
        target.evalId,
        target.caseId,
      ]);
    case 'run-case':
      return JSON.stringify([
        target.kind,
        target.sourceId,
        target.projectKey,
        target.evalId,
        target.runId,
        target.caseId,
      ]);
  }
};

/** Navigation scope stays project-wide even when a case needs its suite identity. */
const isProjectWide = (target: ShellTarget) =>
  target.kind === 'projects' ||
  target.kind === 'project' ||
  target.kind === 'project-runs' ||
  target.kind === 'project-run' ||
  target.kind === 'project-run-case';

/** Only deep locations belong in recent history. */
const isRecordableTarget = (target: ShellTarget): target is RecentTarget =>
  'runId' in target || target.kind === 'case';

export {
  isProjectWide,
  isRecordableTarget,
  recentTargetSchema,
  targetKey,
  type RecentTarget,
  type ShellTarget,
  type ShellSource,
  type ShellProject,
  type ShellEval,
  type NavigationData,
  type ShellBreadcrumb,
  type RecentLabel,
};
