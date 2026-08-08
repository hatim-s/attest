import { describe, expect, it } from 'vitest';

import { CurlImportError, parseCurlCommand } from './curl-parser.js';

/** Captures stable parser diagnostics without ever snapshotting the hostile source text. */
const diagnostics = (operation: () => unknown): string[] => {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof CurlImportError) return error.diagnostics;
    throw error;
  }
  throw new Error('Expected cURL import to fail.');
};

describe('CLI2.10 safe cURL parser', () => {
  it('parses strict request data and replaces selected body fields with typed placeholders', () => {
    const parsed = parseCurlCommand(
      'curl \'https://api.example.test/v1/run?locale=en\' -X POST -H \'Content-Type: application/json\' --data-raw \'{"prompt":"literal","count":2}\'',
      { placeholders: [{ targetPointer: '/prompt', inputPointer: '/question' }] },
    );
    expect(parsed.request).toEqual({
      url: 'https://api.example.test/v1/run',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      query: { locale: 'en' },
      body: { prompt: '{{input/question}}', count: 2 },
      body_encoding: 'json',
    });
  });

  it('converts sensitive header and query captures to references without previewing values', () => {
    const secret = 'must-never-be-returned';
    const parsed = parseCurlCommand(
      `curl 'https://api.example.test/run?api_key=${secret}' -H 'Authorization: Bearer ${secret}'`,
      {
        headerSecrets: { Authorization: 'ATTEST_API_TOKEN' },
        querySecrets: { api_key: 'ATTEST_QUERY_TOKEN' },
      },
    );
    expect(parsed.request.headers).toEqual({ Authorization: { from_env: 'ATTEST_API_TOKEN' } });
    expect(parsed.request.query).toEqual({ api_key: { from_env: 'ATTEST_QUERY_TOKEN' } });
    expect(JSON.stringify(parsed.preview)).not.toContain(secret);
  });

  it('rejects shell syntax and command substitution before parsing any flags', () => {
    expect(diagnostics(() => parseCurlCommand('curl https://example.test; touch /tmp/x'))).toEqual([
      'shell_control',
    ]);
    expect(diagnostics(() => parseCurlCommand('curl "$(printenv TOKEN)"'))).toEqual([
      'shell_expansion',
    ]);
    expect(diagnostics(() => parseCurlCommand('curl `printenv TOKEN`'))).toEqual([
      'shell_expansion',
    ]);
  });

  it('reports all unsupported proxy, multipart, file, binary, redirect, and auth flags', () => {
    expect(
      diagnostics(() =>
        parseCurlCommand(
          'curl --proxy http://proxy --form x=y --data-binary @body --upload-file file --location --user a:b https://example.test',
        ),
      ),
    ).toEqual(['--proxy', '--form', '--data-binary', '--upload-file', '--location', '--user']);
  });

  it('rejects sensitive literals, duplicate headers/query values, methods, URLs, and bodies', () => {
    expect(
      diagnostics(() =>
        parseCurlCommand("curl https://example.test -H 'Authorization: Bearer unsafe'"),
      ),
    ).toEqual(['unsafe_header:authorization']);
    expect(
      diagnostics(() =>
        parseCurlCommand(`curl https://example.test --data '{"api_token":"unsafe"}'`),
      ),
    ).toEqual(['unsafe_body_field:api_token']);
    expect(
      diagnostics(() =>
        parseCurlCommand("curl 'https://example.test?a=1&a=2' -H 'X-A: 1' -H 'x-a: 2'"),
      ),
    ).toEqual(['duplicate_header:x-a']);
    expect(
      diagnostics(() =>
        parseCurlCommand('curl -X POST -X PUT -d {} -d {} https://one.test https://two.test'),
      ),
    ).toEqual(['ambiguous_method', 'ambiguous_body', 'ambiguous_url']);
  });

  it('preserves raw/form bytes and applies explicit form-field mappings', () => {
    expect(
      parseCurlCommand(
        "curl https://example.test -H 'Content-Type: text/plain' --data-raw 'hello world'",
      ).request,
    ).toMatchObject({ body: 'hello world', body_encoding: 'raw' });
    expect(
      parseCurlCommand(
        "curl https://example.test -H 'Content-Type: application/x-www-form-urlencoded' --data 'prompt=hello%20world&mode=fast'",
      ).request,
    ).toMatchObject({
      body: 'prompt=hello%20world&mode=fast',
      body_encoding: 'raw',
    });
    expect(
      parseCurlCommand(
        "curl https://example.test -H 'Content-Type: application/x-www-form-urlencoded' --data 'prompt=old&mode=fast'",
        { placeholders: [{ targetPointer: '/prompt', inputPointer: '/question' }] },
      ).request,
    ).toMatchObject({
      body: 'prompt={{input/question}}&mode=fast',
      body_encoding: 'raw',
    });
  });

  it('accepts a separately resolved file body and never treats binary upload flags as data', () => {
    expect(
      diagnostics(() => parseCurlCommand('curl https://example.test --data @request.json')),
    ).toEqual(['file_body:request.json']);
    expect(
      parseCurlCommand('curl https://example.test --data @request.json', {
        bodyFile: { path: 'request.json', text: '{"prompt":"hello"}' },
      }).request,
    ).toMatchObject({ body: { prompt: 'hello' }, body_encoding: 'json' });
    expect(
      diagnostics(() => parseCurlCommand('curl https://example.test --data-binary @request.json')),
    ).toEqual(['--data-binary']);
  });
});
