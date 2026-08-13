import type { AgentResource, JsonValue, ProjectResources } from '@attest/contracts';

import { AttestCliError } from '../../../errors/index.js';
import type { PublishObserver } from '../../../project/transaction/index.js';
import { loadCommandProject } from '../../project/load-command-project.js';
import type { CommandResult } from '../../shared/command-result.js';
import { executeProjectMutation } from '../../shared/project-mutation.js';
import type { AgentMutationRequest, Prompt } from './types.js';

const candidateFromLoaded = (
  loaded: Awaited<ReturnType<typeof loadCommandProject>>,
): ProjectResources =>
  structuredClone({
    agents: loaded.agents,
    datasets: loaded.datasets,
    metrics: loaded.metrics,
    project: loaded.project,
    tests: loaded.tests,
  });

const promptRequired = async (
  value: string | undefined,
  label: string,
  path: string,
  interactive: boolean,
  prompt: Prompt | undefined,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted === true) throw new AttestCliError('cancelled', 'Command cancelled.');
  if (value?.trim()) return value.trim();
  if (interactive && prompt !== undefined) {
    const answer = (await promptWithSignal(prompt, `${label}: `, signal)).trim();
    if (answer.length > 0) return answer;
  }
  throw new AttestCliError('cli_missing_input', `${label} is required.`, {
    path,
    hint: `Pass ${path} or a complete \`--from-json\` request.`,
  });
};

/** Reads one optional guided value while preserving a documented default. */
const promptDefault = async (
  value: string | undefined,
  question: string,
  fallback: string,
  interactive: boolean,
  prompt: Prompt | undefined,
): Promise<string> => {
  if (value?.trim()) return value.trim();
  if (!interactive || prompt === undefined) return fallback;
  return (await prompt(`${question} [${fallback}]: `)).trim() || fallback;
};

/** Reads one optional guided value, returning undefined for an empty answer. */
const promptOptional = async (
  value: string | undefined,
  question: string,
  interactive: boolean,
  prompt: Prompt | undefined,
): Promise<string | undefined> => {
  if (value?.trim()) return value.trim();
  if (!interactive || prompt === undefined) return undefined;
  const answer = (await prompt(`${question} [none]: `)).trim();
  return answer.length === 0 ? undefined : answer;
};

const commaSeparated = (value: string): string[] | undefined => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? undefined : entries;
};

/** Makes every guided prompt terminate promptly when the command is cancelled. */
const promptWithSignal = async (
  prompt: Prompt,
  question: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal === undefined) return prompt(question);
  if (signal.aborted) throw new AttestCliError('cancelled', 'Command cancelled.');
  return new Promise<string>((resolvePrompt, rejectPrompt) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      action();
    };
    const cancel = (): void =>
      finish(() => rejectPrompt(new AttestCliError('cancelled', 'Command cancelled.')));
    signal.addEventListener('abort', cancel, { once: true });
    // The signal closes the real readline question; the outer race also supports injected prompts.
    void prompt(question, { signal }).then(
      (answer) => finish(() => resolvePrompt(answer)),
      (error: unknown) =>
        finish(() =>
          rejectPrompt(
            signal.aborted || (error instanceof Error && error.name === 'AbortError')
              ? new AttestCliError('cancelled', 'Command cancelled.')
              : error instanceof Error
                ? error
                : new Error('Prompt failed with a non-error rejection.', { cause: error }),
          ),
        ),
    );
  });
};

const assertNoFromJsonFlags = (
  fromJson: string | undefined,
  fields: Readonly<Record<string, unknown>>,
): void => {
  if (fromJson === undefined) return;
  const conflicts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name]) => name)
    .sort();
  if (conflicts.length === 0) return;
  throw new AttestCliError('cli_usage', 'Command request input overlaps with CLI values.', {
    path: '--from-json',
    hint: 'Pass command values in either the request document or flags, not both.',
    details: { conflicting_fields: conflicts },
  });
};

const findAgent = (agents: readonly AgentResource[], id: string): AgentResource => {
  const agent = agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    throw new AttestCliError('resource_not_found', `Agent ${id} does not exist.`, {
      path: id,
      hint: 'Run `attest list agents` and retry with an available id.',
    });
  }
  return agent;
};

const mutationResult = async (
  command: string,
  loaded: Awaited<ReturnType<typeof loadCommandProject>>,
  candidate: ProjectResources,
  request: Pick<AgentMutationRequest, 'dry_run' | 'if_project_hash'>,
  publishObserver?: PublishObserver,
  renames?: readonly { from: string; to: string; type: 'agent' }[],
  warnings?: readonly string[],
  confirmation?: {
    definitionPreview?: JsonValue;
    interactive: boolean;
    nextCommand?: string;
    prompt?: Prompt;
    requireExplicit: boolean;
    yes?: boolean;
  },
): Promise<CommandResult> => {
  const renderPreview = (preview: Awaited<ReturnType<typeof executeProjectMutation>>): string => {
    const operationLines = preview.diff.operations.map((operation) => {
      const renamed = operation.previous_id === undefined ? '' : ` from ${operation.previous_id}`;
      const changes = operation.changes.map(({ path }) => path).join(', ');
      const references = [
        ...operation.references_added.map(({ id }) => `+ref:${id}`),
        ...operation.references_removed.map(({ id }) => `-ref:${id}`),
      ].join(', ');
      const details = [changes, references].filter((value) => value.length > 0).join('; ');
      return `- ${operation.op} ${operation.resource.type} ${operation.resource.id}${renamed}${details.length === 0 ? '' : ` (${details})`}`;
    });
    return [
      `${command} ${request.dry_run === true ? 'preview' : 'changes'}:`,
      ...(operationLines.length === 0 ? ['- no semantic changes'] : operationLines),
      ...preview.diff.warnings.map((warning) => `Warning: ${warning}`),
      ...(confirmation?.definitionPreview === undefined
        ? []
        : [`Redacted definition preview: ${JSON.stringify(confirmation.definitionPreview)}`]),
    ].join('\n');
  };
  const result = await executeProjectMutation({
    dryRun: request.dry_run === true,
    mutation: {
      candidate,
      expectedProjectHash: request.if_project_hash,
      projectRoot: loaded.root,
      renames,
      warnings,
    },
    publishObserver,
    confirm: async (preview) => {
      if (confirmation?.yes === true) return;
      const previewText = renderPreview(preview);
      if (confirmation?.interactive === true && confirmation.prompt !== undefined) {
        const answer = (
          await confirmation.prompt(`${previewText}\nApply these changes? [y/N]: `)
        ).trim();
        if (!/^y(?:es)?$/iu.test(answer)) {
          throw new AttestCliError('cancelled', 'Project mutation was not confirmed.');
        }
      } else if (confirmation?.requireExplicit === true) {
        throw new AttestCliError('cli_usage', 'This destructive mutation requires confirmation.', {
          path: '--yes',
          hint: 'Review `--dry-run --output json`, then pass `--yes` to apply the exact cascade.',
          details: { operations: preview.diff.operations as unknown as JsonValue },
        });
      }
    },
  });
  const previewText = renderPreview(result);
  const verb = request.dry_run === true ? 'would apply' : 'applied';
  const next =
    request.dry_run === true || confirmation?.nextCommand === undefined
      ? ''
      : `\nNext: ${confirmation.nextCommand}`;
  return {
    human: `${previewText}\n${command} ${verb} ${result.diff.operations.length} operation(s).\nProject hash: ${result.projectHashAfter}${next}`,
    projectHashAfter: result.projectHashAfter,
    projectHashBefore: result.projectHashBefore,
    result: {
      committed: result.committed,
      dry_run: request.dry_run === true,
      operations: result.diff.operations as unknown as JsonValue,
      warnings: result.diff.warnings as unknown as JsonValue,
      ...(confirmation?.definitionPreview === undefined
        ? {}
        : { import_preview: confirmation.definitionPreview }),
      ...(request.dry_run === true || confirmation?.nextCommand === undefined
        ? {}
        : { next_command: confirmation.nextCommand }),
    },
  };
};

export {
  assertNoFromJsonFlags,
  candidateFromLoaded,
  commaSeparated,
  findAgent,
  mutationResult,
  promptDefault,
  promptOptional,
  promptRequired,
};
