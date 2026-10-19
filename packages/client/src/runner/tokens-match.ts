const encoder = new TextEncoder();

/**
 * Compares two secrets in time that depends only on their lengths. Web Crypto has no
 * `timingSafeEqual`, and this module must run on Workers without `node:crypto`.
 */
const tokensMatch = (received: string, expected: string): boolean => {
  const left = encoder.encode(received);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;

  for (let index = 0; index < right.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
};

export { tokensMatch };
