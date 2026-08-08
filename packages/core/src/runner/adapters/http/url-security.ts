import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

import { AgentInvocationError } from '../../errors.js';

type ResolvedHttpUrl = {
  address: string;
  family: 4 | 6;
  loopback: boolean;
  url: URL;
};

const isIpv4Loopback = (address: string): boolean => address.startsWith('127.');

/** Rejects private, link-local, unspecified, multicast, and carrier-grade IPv4 ranges. */
const isSafeIpv4 = (address: string): boolean => {
  const octets = address.split('.').map(Number);
  const [first = -1, second = -1, third = -1] = octets;
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) return false;
  if (isIpv4Loopback(address)) return true;
  return !(
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && [0, 2].includes(third)) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && [18, 19].includes(second)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
};

const normalizedIpv6 = (address: string): string => address.toLowerCase().split('%')[0]!;

/** Allows public IPv6 and explicit loopback while rejecting local/special address classes. */
const isSafeIpv6 = (address: string): boolean => {
  const normalized = normalizedIpv6(address);
  if (normalized === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  if (mapped !== undefined) return isSafeIpv4(mapped);
  return !(
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
};

const isLoopbackAddress = (address: string): boolean =>
  isIP(address) === 4 ? isIpv4Loopback(address) : normalizedIpv6(address) === '::1';

const isSafeAddress = (address: string): boolean =>
  isIP(address) === 4 ? isSafeIpv4(address) : isIP(address) === 6 && isSafeIpv6(address);

/** Validates an HTTP URL and pins a previously validated DNS result for the ensuing connection. */
const resolveSafeHttpUrl = async (
  value: string,
  timeoutMs: number,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
): Promise<ResolvedHttpUrl> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new AgentInvocationError('network', 'Mapped HTTP URL is invalid.', { cause: error });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AgentInvocationError(
      'network',
      'Mapped HTTP URL must use HTTP(S) without credentials or a fragment.',
    );
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  let addresses: { address: string; family: 4 | 6 }[];
  try {
    addresses = (await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        combined.addEventListener(
          'abort',
          () =>
            reject(
              combined.reason instanceof Error
                ? combined.reason
                : new DOMException('Aborted', 'AbortError'),
            ),
          { once: true },
        );
      }),
    ])) as { address: string; family: 4 | 6 }[];
  } catch (error: unknown) {
    throw new AgentInvocationError(
      callerSignal?.aborted === true
        ? 'cancelled'
        : signal?.aborted === true
          ? 'timeout'
          : 'network',
      callerSignal?.aborted === true
        ? 'Mapped HTTP invocation was cancelled.'
        : signal?.aborted === true
          ? 'Mapped HTTP hostname resolution timed out.'
          : 'Mapped HTTP hostname could not be resolved safely.',
      { cause: error },
    );
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isSafeAddress(address))) {
    throw new AgentInvocationError(
      'network',
      'Mapped HTTP hostname resolves to a prohibited network address.',
    );
  }
  const selected = addresses[0]!;
  return {
    address: selected.address,
    family: selected.family,
    loopback: addresses.every(({ address }) => isLoopbackAddress(address)),
    url,
  };
};

/** Requires a redirect or polling URL to retain the exact configured origin. */
const requireSameOrigin = (candidate: URL, origin: URL): void => {
  if (candidate.origin !== origin.origin) {
    throw new AgentInvocationError(
      'http_status',
      'Mapped HTTP redirect or polling URL changed origin.',
    );
  }
};

export { requireSameOrigin, resolveSafeHttpUrl, type ResolvedHttpUrl };
