import { isIP } from 'node:net';

import { AgentInvocationError } from '../../errors.js';

/** True for names that can only reach this host. */
const loopbackHost = (hostname: string): boolean => {
  if (hostname === 'localhost') return true;
  if (isIP(hostname) === 4) return hostname.startsWith('127.');
  return hostname === '::1';
};

/** Prevents a managed local process definition from becoming a general network pivot. */
const assertLoopbackUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new AgentInvocationError('network', 'Background agent URL is invalid.', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !loopbackHost(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AgentInvocationError(
      'network',
      'Background agents require credential-free loopback HTTP endpoints.',
    );
  }
  return url;
};

export { assertLoopbackUrl, loopbackHost };
