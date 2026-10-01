import { spawn } from 'node:child_process';

const BROWSER_OPENERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'open',
  linux: 'xdg-open',
};

/** Opens one local URL with the platform browser, returning false on unsupported platforms. */
const openBrowser = async (url: string): Promise<boolean> => {
  const executable = BROWSER_OPENERS[process.platform];
  if (executable === undefined) return false;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      // The browser outlives the CLI; only the view server's lifecycle is controlled here.
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
  return true;
};

export { openBrowser };
