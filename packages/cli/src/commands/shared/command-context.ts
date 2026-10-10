import type { Command } from 'commander';
import type * as CloudAdapter from '@attest/local/cloud';
import type * as EvalAdapter from '@attest/local/eval';

import type { CliInteraction } from './cli-interaction.js';

type CliIo = {
  error: (message: string) => void;
  output: (message: string) => void;
};

/** Host-owned service overrides retain the local adapters' real contracts. */
type CliServices = {
  cloud?: Partial<
    Pick<
      typeof CloudAdapter,
      'authenticatedCloudClient' | 'pushCloudProject' | 'resolveCloudProject' | 'runCloud'
    >
  >;
  eval?: Partial<Pick<typeof EvalAdapter, 'runConfiguration' | 'cancelConfiguration'>>;
};

/** What every command registration needs: the root program, terminal I/O, and invocation facts. */
type CommandContext = {
  argv: readonly string[];
  services?: CliServices;
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  workingDirectory: string;
};

export { type CliIo, type CliServices, type CommandContext };
