import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { AttestCliError } from '../errors.js';
import { QUICKSTART_TEMPLATES } from './templates.js';

type InitProjectOptions = {
  force?: boolean;
};

type InitProjectResult = {
  files: string[];
  targetDirectory: string;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Creates a runnable quickstart only after preflighting every destination for safe writes. */
const initProject = async (
  requestedDirectory: string,
  workingDirectory: string,
  options: InitProjectOptions = {},
): Promise<InitProjectResult> => {
  const targetDirectory = resolve(workingDirectory, requestedDirectory);
  const files = QUICKSTART_TEMPLATES.map(({ path }) => resolve(targetDirectory, path));
  if (options.force !== true) {
    const existingFiles = (
      await Promise.all(files.map(async (path) => ((await pathExists(path)) ? path : undefined)))
    ).filter((path): path is string => path !== undefined);
    if (existingFiles.length > 0) {
      throw new AttestCliError(
        'init_conflict',
        `Refusing to overwrite existing quickstart files:\n${existingFiles.join('\n')}\nUse --force only if replacing them is intentional.`,
      );
    }
  }

  try {
    for (const template of QUICKSTART_TEMPLATES) {
      const outputPath = resolve(targetDirectory, template.path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, template.contents, {
        encoding: 'utf8',
        flag: options.force === true ? 'w' : 'wx',
      });
    }
  } catch (error: unknown) {
    throw new AttestCliError(
      'init_failed',
      `Could not initialize the quickstart in ${targetDirectory}.`,
      { cause: error },
    );
  }

  return { files, targetDirectory };
};

export { initProject, type InitProjectOptions, type InitProjectResult };
