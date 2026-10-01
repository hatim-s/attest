import { errnoCode } from './errno-code.js';

/**
 * Checks whether a pid is alive with signal 0, which delivers nothing. EPERM still proves the
 * process exists even though this user cannot signal it.
 */
const isProcessPresent = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errnoCode(error) === 'EPERM';
  }
};

export { isProcessPresent };
