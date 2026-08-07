import {
  createCliSuccessResult,
  serializeCliResult,
  type CliResultOptions,
} from '../output/cli-protocol.js';
import type { JsonValue } from '../project/canonical-project.js';

type CommandResult = CliResultOptions & {
  human: string;
  result: JsonValue;
};

/** Renders one command result through the shared human or structured CLI contract. */
const renderCommandResult = (
  command: string,
  output: 'human' | 'json',
  commandResult: CommandResult,
): string =>
  output === 'json'
    ? serializeCliResult(createCliSuccessResult(command, commandResult.result, commandResult))
    : commandResult.human;

export { renderCommandResult, type CommandResult };
