import { join } from 'node:path';

const PROJECT_STORE_PATH = '.attest/runs.db';

/** Locates the conventional run store without creating or validating filesystem entries. */
const projectStorePath = (root: string): string => join(root, PROJECT_STORE_PATH);

export { PROJECT_STORE_PATH, projectStorePath };
