import { z } from 'zod';
import type { ApiCapabilities } from '@attest/api/contract';
import type { ProjectRecord } from '@attest/core/records';

const identity = z.string().min(1).max(256);

const scope = { sourceId: identity, projectKey: identity, evalId: identity };

const recentTargetSchema = z.discriminatedUnion('kind', [
  z.object({ ...scope, kind: z.literal('run'), runId: identity }).strict(),
  z.object({ ...scope, kind: z.literal('case'), caseId: identity }).strict(),
  z.object({ ...scope, kind: z.literal('run-case'), runId: identity, caseId: identity }).strict(),
]);

type RecentTarget = z.infer<typeof recentTargetSchema>;

type ShellTarget =
  | { kind: 'projects'; sourceId: string }
  | { kind: 'project'; sourceId: string; projectKey: string }
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

type ShellEval = { id: string; name: string };

type ShellProject = Pick<ProjectRecord, 'key' | 'name'> & { evals: readonly ShellEval[] };

type ShellBreadcrumb = { label: string; target: ShellTarget };

type RecentLabel = { label: string; context: string };

/** Tuple encoding keeps delimiters in opaque domain identifiers unambiguous. */
const targetKey = (target: ShellTarget): string => {
  switch (target.kind) {
    case 'projects':
      return JSON.stringify([target.kind, target.sourceId]);
    case 'project':
      return JSON.stringify([target.kind, target.sourceId, target.projectKey]);
    case 'runs':
    case 'cases':
      return JSON.stringify([target.kind, target.sourceId, target.projectKey, target.evalId]);
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

export {
  recentTargetSchema,
  targetKey,
  type RecentTarget,
  type ShellTarget,
  type ShellSource,
  type ShellProject,
  type ShellBreadcrumb,
  type RecentLabel,
};
