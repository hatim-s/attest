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

type ProjectsAddOptions = CommonCliOptions & { name?: string };

/** One line per project: key, name and root, in registration order. */
const renderProjectList = (entries: RegistryEntry[]): string =>
  entries.length === 0
    ? 'No registered projects. Run `attest projects add <dir>` to register one.'
    : entries.map(({ key, name, root }) => `  ${key}  ${name}  ${root}`).join('\n');

/** Registers `attest projects list|add|remove` over the global project registry. */
const registerProjectsCommands = ({
  io,
  program,
  registryPath,
  workingDirectory,
}: CommandContext): void => {
  const projects = program
    .command('projects')
    .description('List, register and remove projects in the global registry.');

  projects
    .command('list')
    .description('List registered projects.')
    .addOption(commonOption(outputOption()))
    .action(async (options: CommonCliOptions) => {
      const { projects: entries } = await readRegistry(registryPath);

      io.output(renderResult('projects.list', outputFormat(options), entries, renderProjectList));
    });

  projects
    .command('add')
    .description('Register a project directory so `attest view --all` serves it.')
    .argument('[directory]', 'project directory', '.')
    .option('--name <name>', 'display name; defaults to the manifest name or directory name')
    .addOption(commonOption(outputOption()))
    .action(async (directory: string, options: ProjectsAddOptions) => {
      const entry = await addProject({
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
    });

  projects
    .command('remove')
    .description('Remove a project from the registry; its files stay untouched.')
    .argument('<key-or-dir>', 'registered key or project directory')
    .addOption(commonOption(outputOption()))
    .action(async (keyOrRoot: string, options: CommonCliOptions) => {
      const entry = await unregisterProject({ registryPath, keyOrRoot, workingDirectory });

      io.output(
        renderResult(
          'projects.remove',
          outputFormat(options),
          entry,
          ({ key, root }) => `Removed ${key} (${root}).`,
        ),
      );
    });

  setCliCommandHelpMetadata(projects, {
    examples: ['attest projects add .', 'attest projects list --output json', 'attest view --all'],
  });
};

export { registerProjectsCommands };
