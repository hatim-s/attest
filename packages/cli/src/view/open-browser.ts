import { spawn } from 'node:child_process';

/** Opens one local URL with the platform browser, returning false on unsupported platforms. */
const openBrowser = async (url: string, platform = process.platform): Promise<boolean> => {
  const command =
    platform === 'darwin'
      ? { executable: 'open', arguments: [url] }
      : platform === 'linux'
        ? { executable: 'xdg-open', arguments: [url] }
        : undefined;
  if (command === undefined) return false;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('spawn', () => {
      // Browser ownership outlives the CLI child; the view server remains the controlled lifecycle.
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
  return true;
};

export { openBrowser };
