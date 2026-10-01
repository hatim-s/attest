import type { Command } from 'commander';

import type { CliInteraction } from './cli-interaction.js';

type CliIo = {
  error: (message: string) => void;
  output: (message: string) => void;
};

/** What every command registration needs: the root program, terminal I/O, and invocation facts. */
type CommandContext = {
  argv: readonly string[];
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

export { type CliIo, type CommandContext };
