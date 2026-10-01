import { AgentInvocationError } from '../../errors.js';

/** Requires a redirect or polling URL to retain the exact configured origin. */
const requireSameOrigin = (candidate: URL, origin: URL): void => {
  if (candidate.origin !== origin.origin) {
    throw new AgentInvocationError(
      'http_status',
      'Mapped HTTP redirect or polling URL changed origin.',
    );
  }
};

export { requireSameOrigin };
