import { isAbsolute, relative, sep } from 'node:path';

/** Returns whether a resolved candidate path is the project root or one of its descendants. */
const isProjectPath = (root: string, candidate: string): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
};

export { isProjectPath };
