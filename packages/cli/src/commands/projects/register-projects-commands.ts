import * as Effect from 'effect/Effect';
import {
  addProject,
  readRegistry,
  unregisterProject,
  type RegistryEntry,
} from '@attest/local/registry';
import { setCliCommandHelpMetadata } from '../../help/command-help.js';
import { commonOption, outputFormat, outputOption } from '../shared/cli-options.js';
import type { CommonCliOptions } from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { renderResult } from '../shared/command-result.js';

type ProjectsAddOptions = CommonCliOptions & {
  name?: string;
};

/** One line per project: key, name and root, in registration order. */
const renderProjectList = (entries: readonly RegistryEntry[]): string =>
  entries.length === 0
    ? 'No registered projects. Run `attest projects add <dir>` to register one.'
    : entries.map(({ key, name, root }) => `  ${key}  ${name}  ${root}`).join('\n');

/** Registers `attest projects list|add|remove` over the global project registry. */
const registerProjectsCommands = ({
  io,
  program,
  registryPath,
  submit,
  workingDirectory,
}: CommandContext): void => {
  const projects = program
    .command('projects')
    .description('List, register and remove projects in the global registry.');

  projects
    .command('list')
    .description('List registered projects.')
    .addOption(commonOption(outputOption()))
    .action((options: CommonCliOptions) =>
      submit(
        Effect.gen(function* () {
          const { projects: entries } = yield* readRegistry(registryPath);

          io.output(
            renderResult('projects.list', outputFormat(options), entries, renderProjectList),
          );
        }),
      ),
    );
  projects
    .command('add')
    .description('Register a project directory so `attest web --all` serves it.')
    .argument('[directory]', 'project directory', '.')
    .option('--name <name>', 'display name; defaults to the manifest name or directory name')
    .addOption(commonOption(outputOption()))
    .action((directory: string, options: ProjectsAddOptions) =>
      submit(
        Effect.gen(function* () {
          const entry = yield* addProject({
            registryPath,
            directory,
            name: options.name,
            workingDirectory,
          });

          io.output(
            renderResult(
              'projects.add',
              outputFormat(options),
              entry,
              ({ key, name, root }) => `Registered ${name} as ${key} (${root}).`,
            ),
          );
        }),
      ),
    );
  projects
    .command('remove')
    .description('Remove a project from the registry; its files stay untouched.')
    .argument('<key-or-dir>', 'registered key or project directory')
    .addOption(commonOption(outputOption()))
    .action((keyOrRoot: string, options: CommonCliOptions) =>
      submit(
        Effect.gen(function* () {
          const entry = yield* unregisterProject({ registryPath, keyOrRoot, workingDirectory });

          io.output(
            renderResult(
              'projects.remove',
              outputFormat(options),
              entry,
              ({ key, root }) => `Removed ${key} (${root}).`,
            ),
          );
        }),
      ),
    );
  setCliCommandHelpMetadata(projects, {
    examples: ['attest projects add .', 'attest projects list --output json', 'attest web --all'],
  });
};

export { registerProjectsCommands };
