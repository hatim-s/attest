import type { AgentResource, JsonValue, ProjectResources } from '@attest/contracts';
import { z } from 'zod';

import { LocalError } from '../../../errors/index.js';
import type { LoadedProject } from '../../../project/project-loader/index.js';
import type { CommandResult, MutationResult } from '../../shared/command-result.js';
import { executeProjectMutation } from '../../shared/project-mutation.js';
import type { Prompt } from '../../shared/prompt.js';
import type { AgentMutationRequest } from './types.js';

/** Finds one authored agent or reports the missing id with a way to list them. */
const findAgent = (agents: readonly AgentResource[], id: string): AgentResource => {
  const agent = agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    throw new LocalError('resource_not_found', `Agent ${id} does not exist.`, {
      path: id,
      hint: 'Run `attest list agents` and retry with an available id.',
    });
  }
  return agent;
};

type AgentMutationOptions = {
  candidate: ProjectResources;
  command: string;
  confirmation: {
    definitionPreview?: JsonValue;
    interactive: boolean;
    nextCommand?: string;
    prompt?: Prompt;
    requireExplicit: boolean;
    yes?: boolean;
  };
  loaded: LoadedProject;
  renames?: readonly { from: string; to: string; type: 'agent' }[];
  request: Pick<AgentMutationRequest, 'dry_run' | 'if_project_hash'>;
  warnings?: readonly string[];
};

/** Previews, confirms, and publishes one agent mutation with the rendered semantic diff. */
const mutationResult = async ({
  candidate,
  command,
  confirmation,
  loaded,
  renames,
  request,
  warnings,
}: AgentMutationOptions): Promise<CommandResult<'mutation', MutationResult>> => {
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
      ...(confirmation.definitionPreview === undefined
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
    confirm: async (preview) => {
      if (confirmation.yes === true) return;
      const previewText = renderPreview(preview);
      if (confirmation.interactive === true && confirmation.prompt !== undefined) {
        const answer = (
          await confirmation.prompt(`${previewText}\nApply these changes? [y/N]: `)
        ).trim();
        if (!/^y(?:es)?$/iu.test(answer)) {
          throw new LocalError('cancelled', 'Project mutation was not confirmed.');
        }
      } else if (confirmation.requireExplicit === true) {
        throw new LocalError('cli_usage', 'This destructive mutation requires confirmation.', {
          path: '--yes',
          hint: 'Review `--dry-run --output json`, then pass `--yes` to apply the exact cascade.',
          details: { operations: z.json().parse(preview.diff.operations) },
        });
      }
    },
  });
  return {
    operation: 'mutation',
    projectHashAfter: result.projectHashAfter,
    projectHashBefore: result.projectHashBefore,
    result: {
      committed: result.committed,
      dry_run: request.dry_run === true,
      operations: result.diff.operations,
      warnings: result.diff.warnings,
      ...(confirmation.definitionPreview === undefined
        ? {}
        : { import_preview: confirmation.definitionPreview }),
      ...(request.dry_run === true || confirmation.nextCommand === undefined
        ? {}
        : { next_command: confirmation.nextCommand }),
    },
  };
};

export { findAgent, mutationResult };
