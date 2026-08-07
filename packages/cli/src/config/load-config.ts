import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import { parseConfig, type Config, type ContractIssue } from '@attest/contracts';
import { parseDocument } from 'yaml';

import { AttestCliError } from '../errors.js';
import { hashCanonicalConfig, serializeCanonicalConfig } from './canonical-config.js';

const DEFAULT_CONFIG_FILES = [
  'attest.config.yaml',
  'attest.config.yml',
  'attest.config.json',
] as const;

type LoadedConfig = {
  baseDirectory: string;
  canonicalJson: string;
  config: Config;
  configHash: string;
  configPath: string;
};

const formatContractIssues = (configPath: string, issues: ContractIssue[]): string =>
  issues.map(({ path, message }) => `${configPath}:${path}: ${message}`).join('\n');

const readConfigSource = async (configPath: string): Promise<string> => {
  try {
    return await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    throw new AttestCliError(
      'config_read_failed',
      `Could not read config ${configPath}. Check that the file exists and is readable.`,
      { cause: error },
    );
  }
};

const parseJsonSource = (source: string, configPath: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'unknown JSON parser error';
    throw new AttestCliError(
      'config_parse_failed',
      `Could not parse JSON config ${configPath}: ${detail}`,
      { cause: error },
    );
  }
};

const parseYamlSource = (source: string, configPath: string): unknown => {
  const document = parseDocument(source, {
    merge: false,
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new AttestCliError(
      'config_parse_failed',
      `Could not parse YAML config ${configPath}:\n${document.errors.map(({ message }) => message).join('\n')}`,
    );
  }

  try {
    // Aliases are deliberately disabled: configs must remain JSON-equivalent and local to one node.
    return document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'unknown YAML conversion error';
    throw new AttestCliError(
      'config_parse_failed',
      `Could not convert YAML config ${configPath}: ${detail}`,
      { cause: error },
    );
  }
};

const parseConfigSource = (source: string, configPath: string): unknown =>
  extname(configPath).toLowerCase() === '.json'
    ? parseJsonSource(source, configPath)
    : parseYamlSource(source, configPath);

/** Discovers the first documented config name without silently searching parent directories. */
const discoverConfigPath = async (workingDirectory: string): Promise<string> => {
  for (const fileName of DEFAULT_CONFIG_FILES) {
    const candidate = resolve(workingDirectory, fileName);
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch (error: unknown) {
      const code =
        error instanceof Error && 'code' in error ? Reflect.get(error, 'code') : undefined;
      if (code !== 'ENOENT') {
        throw new AttestCliError(
          'config_read_failed',
          `Could not inspect config candidate ${candidate}.`,
          { cause: error },
        );
      }
    }
  }

  throw new AttestCliError(
    'config_not_found',
    `No attest config found in ${workingDirectory}. Expected ${DEFAULT_CONFIG_FILES.join(', ')} or pass --config.`,
  );
};

/** Loads, validates, canonicalizes, and hashes one JSON or YAML config before agent execution. */
const loadConfig = async (
  requestedPath: string | undefined,
  workingDirectory: string,
): Promise<LoadedConfig> => {
  const configPath =
    requestedPath === undefined
      ? await discoverConfigPath(workingDirectory)
      : resolve(workingDirectory, requestedPath);
  const source = await readConfigSource(configPath);
  const parsed = parseConfig(parseConfigSource(source, configPath));
  if (!parsed.ok) {
    throw new AttestCliError(
      'config_invalid',
      `Config validation failed:\n${formatContractIssues(configPath, parsed.error)}`,
    );
  }

  const canonicalJson = serializeCanonicalConfig(parsed.value);
  return {
    baseDirectory: dirname(configPath),
    canonicalJson,
    config: parsed.value,
    configHash: hashCanonicalConfig(canonicalJson),
    configPath,
  };
};

export { DEFAULT_CONFIG_FILES, discoverConfigPath, loadConfig, type LoadedConfig };
