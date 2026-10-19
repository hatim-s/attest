/**
 * Reads a request body as UTF-8 text, or returns `undefined` once it exceeds `maxBytes`. The
 * declared `content-length` is checked first so an honest oversized upload is refused unread.
 */
const readBoundedText = async (request: Request, maxBytes: number): Promise<string | undefined> => {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return undefined;

  if (request.body === null) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > maxBytes) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
};

export { readBoundedText };
