import { isAbsolute, resolve } from 'node:path';

import type { Config } from '@attest/contracts';

const isExplicitRelativePath = (value: string): boolean =>
  value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../');

/** Resolves explicit relative CLI argv paths before the runner moves execution into its isolated cwd. */
const resolveAgentTarget = (config: Config, baseDirectory: string): Config => {
  if (config.agent.type !== 'cli') {
    return config;
  }

  return {
    ...config,
    agent: {
      ...config.agent,
      command: config.agent.command.map((argument) =>
        isAbsolute(argument) || !isExplicitRelativePath(argument)
          ? argument
          : resolve(baseDirectory, argument),
      ),
    },
  };
};

export { isExplicitRelativePath, resolveAgentTarget };
