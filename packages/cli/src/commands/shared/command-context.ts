import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

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
      | 'authenticatedCloudClient'
      | 'pushCloudProject'
      | 'resolveCloudProject'
      | 'runCloud'
      | 'uploadCloudRun'
      | 'createCloudProjectToken'
      | 'listCloudProjectTokens'
      | 'revokeCloudProjectToken'
    >
  >;
  eval?: Partial<Pick<typeof EvalAdapter, 'runConfiguration' | 'cancelConfiguration'>>;
};

/** What every command registration needs: the root program, terminal I/O, and invocation facts. */
type CommandContext = {
  argv: readonly string[];
  /** Cloud credentials file under the Attest home, resolved once per invocation. */
  credentialPath: string;
  services?: CliServices;
  interaction: CliInteraction;
  io: CliIo;
  program: Command;
  /** Global project registry file under the Attest home, resolved once per invocation. */
  registryPath: string;
  workingDirectory: string;
};

type AttestHomeInputs = {
  attestHome: string | undefined;
  homeDirectory: string;
  workingDirectory: string;
};

/**
 * Resolves symbolic links in the longest existing prefix of `path` and appends the rest, so an
 * `ATTEST_HOME` that does not exist yet still resolves. Any failure moves up one level: a path
 * that is really unusable fails later in the registry or credential call, with its own error.
 */
const realpathOfExistingPrefix = async (path: string): Promise<string> => {
  const parent = dirname(path);

  try {
    return await realpath(path);
  } catch {
    return parent === path ? path : join(await realpathOfExistingPrefix(parent), basename(path));
  }
};

/**
 * Finds the per-user files. `ATTEST_HOME` replaces `~/.attest` and is resolved through symbolic
 * links here, once: the user chose that path. The default `~/.attest` is not resolved, so the
 * library's symlink check still rejects a link planted there.
 */
const resolveAttestPaths = async ({
  attestHome,
  homeDirectory,
  workingDirectory,
}: AttestHomeInputs): Promise<Pick<CommandContext, 'credentialPath' | 'registryPath'>> => {
  const home =
    attestHome === undefined || attestHome === ''
      ? join(homeDirectory, '.attest')
      : await realpathOfExistingPrefix(resolve(workingDirectory, attestHome));

  return {
    registryPath: join(home, 'projects.json'),
    credentialPath: join(home, 'cloud', 'credentials.json'),
  };
};

export { resolveAttestPaths, type CliIo, type CliServices, type CommandContext };
