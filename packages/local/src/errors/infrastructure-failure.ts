import type { AnchoredCleanupFailure, AnchoredFileFailure } from '../internal/open-anchored.js';
import type { ProcessPresenceFailure } from '../internal/process-presence.js';
import type { ViewServerFailure } from '../view-server/view-server-failure.js';

/**
 * Filesystem, process and listener failures that local operations keep with their original
 * cause instead of assigning a `LocalError` code. Each one is tagged, so a renderer can switch
 * on `_tag`.
 */
type LocalInfrastructureFailure =
  AnchoredFileFailure | AnchoredCleanupFailure | ProcessPresenceFailure | ViewServerFailure;

export { type LocalInfrastructureFailure };
