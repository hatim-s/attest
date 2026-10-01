import type { AgentRequest, HttpRequestTemplate, JsonValue } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { readJsonPointer } from './json-pointer.js';

type ResolvedHttpRequestTemplate = Omit<HttpRequestTemplate, 'headers' | 'query'> & {
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

type RequestTemplateOverrides = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

type MaterializedHttpRequest = {
  body?: string;
  headers: Record<string, string>;
  method: HttpRequestTemplate['method'];
  url: string;
};

/** `{{input/...}}` or `{{request/...}}` followed by an RFC 6901 pointer into that document. */
const PLACEHOLDER_SOURCE = String.raw`\{\{(?<root>input|request)(?<pointer>(?:/(?:[^~/]|~[01])*)*)\}\}`;
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'gu');
const EXACT_PLACEHOLDER = new RegExp(`^${PLACEHOLDER_SOURCE}$`, 'u');

/** Rejects case-controlled URL origins before any placeholder materialization occurs. */
const assertStaticUrlAuthority = (template: string): void => {
  const separator = template.indexOf('://');
  const authorityStart = separator + 3;
  const authorityEnd = template.slice(authorityStart).search(/[/?#]/u);
  const authority = template.slice(
    authorityStart,
    authorityEnd < 0 ? undefined : authorityStart + authorityEnd,
  );
  if (
    separator <= 0 ||
    template.slice(0, authorityStart).includes('{{') ||
    authority.includes('{{')
  ) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'HTTP URL placeholders are allowed only in path or query components.',
    );
  }
};

/** Resolves one placeholder; static requests have no case request, so any placeholder is an error. */
const placeholderValue = (
  request: AgentRequest | undefined,
  root: string,
  pointer: string,
): unknown => {
  if (request === undefined) {
    throw new AgentInvocationError(
      'invalid_envelope',
      'This HTTP request is sent outside a case and cannot use placeholders.',
    );
  }
  return readJsonPointer(root === 'input' ? request.input : request, pointer);
};

const scalarText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new AgentInvocationError(
    'invalid_envelope',
    'HTTP path, query, and header placeholders must resolve to JSON scalars.',
  );
};

const interpolateText = (
  template: string,
  request: AgentRequest | undefined,
  encode: boolean,
): string =>
  template.replaceAll(PLACEHOLDER, (_match, root: string, pointer: string) => {
    const value = placeholderValue(request, root, pointer);
    if (value === undefined) {
      throw new AgentInvocationError('invalid_envelope', 'An HTTP request placeholder is missing.');
    }
    const text = scalarText(value);
    return encode ? encodeURIComponent(text) : text;
  });

const mapBodyValue = (value: JsonValue, request: AgentRequest | undefined): JsonValue => {
  if (typeof value === 'string') {
    const exact = EXACT_PLACEHOLDER.exec(value)?.groups;
    if (exact?.root !== undefined && exact.pointer !== undefined) {
      const mapped = placeholderValue(request, exact.root, exact.pointer);
      if (mapped === undefined) {
        throw new AgentInvocationError('invalid_envelope', 'An HTTP body placeholder is missing.');
      }
      return mapped as JsonValue;
    }
    return interpolateText(value, request, false);
  }
  if (Array.isArray(value)) return value.map((entry) => mapBodyValue(entry, request));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, mapBodyValue(entry, request)]),
    );
  }
  return value;
};

/** Replaces authored secret references with their runtime values; a missing value is an error. */
const resolveTemplateValues = (
  authored: HttpRequestTemplate['headers'],
  overrides: Record<string, string> | undefined,
  label: string,
): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(authored ?? {})) {
    const override = overrides?.[name];
    if (override !== undefined) {
      resolved[name] = override;
      continue;
    }
    if (typeof value !== 'string') {
      throw new AgentInvocationError(
        'invalid_envelope',
        `HTTP ${label} ${name} references a secret that was not resolved at runtime.`,
      );
    }
    resolved[name] = value;
  }
  return { ...resolved, ...overrides };
};

/**
 * Applies runtime-resolved headers and query values to an authored request template. Callers
 * resolve secret references outside the executor, so every reference must have an override.
 */
const resolveRequestTemplate = (
  template: HttpRequestTemplate,
  overrides: RequestTemplateOverrides,
): ResolvedHttpRequestTemplate => ({
  ...template,
  headers: resolveTemplateValues(template.headers, overrides.headers, 'header'),
  query: resolveTemplateValues(template.query, overrides.query, 'query parameter'),
});

/**
 * Approximates the bytes a request puts on the wire as its HTTP/1.1 request line, header lines,
 * and body. The cap only has to bound authored growth, so exact framing does not matter.
 */
const approximateRequestBytes = (
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string | undefined,
): number => {
  const requestLine = Buffer.byteLength(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n`);
  const headerLines = Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(`${name}: ${value}\r\n`),
    0,
  );
  const bodyBytes = body === undefined ? 0 : Buffer.byteLength(body);
  return requestLine + headerLines + Buffer.byteLength('\r\n') + bodyBytes;
};

const materialize = (
  template: ResolvedHttpRequestTemplate,
  request: AgentRequest | undefined,
  requestCapBytes: number,
): MaterializedHttpRequest => {
  assertStaticUrlAuthority(template.url);
  const url = new URL(interpolateText(template.url, request, true));
  for (const [name, value] of Object.entries(template.query ?? {})) {
    if (url.searchParams.has(name)) {
      throw new AgentInvocationError('invalid_envelope', 'HTTP query mapping is ambiguous.');
    }
    url.searchParams.set(name, interpolateText(value, request, false));
  }
  const headers = Object.fromEntries(
    Object.entries(template.headers ?? {}).map(([name, value]) => [
      name,
      interpolateText(value, request, false),
    ]),
  );
  const bodyValue = template.body === undefined ? undefined : mapBodyValue(template.body, request);
  let body: string | undefined;
  if (bodyValue !== undefined) {
    if (template.body_encoding === 'raw') {
      if (typeof bodyValue !== 'string') {
        throw new AgentInvocationError(
          'invalid_envelope',
          'Raw HTTP request bodies must be strings.',
        );
      }
      body = bodyValue;
    } else {
      body = JSON.stringify(bodyValue);
    }
  }
  if (
    body !== undefined &&
    !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  ) {
    headers['content-type'] = 'application/json';
  }
  if (approximateRequestBytes(template.method, url, headers, body) > requestCapBytes) {
    throw new AgentInvocationError(
      'output_cap_exceeded',
      `Mapped HTTP request exceeds the ${requestCapBytes}-byte request cap.`,
    );
  }
  return {
    method: template.method,
    url: url.toString(),
    headers,
    ...(body === undefined ? {} : { body }),
  };
};

/** Materializes one mapped request while encoding URL substitutions and preserving JSON body types. */
const materializeHttpRequest = (
  template: ResolvedHttpRequestTemplate,
  request: AgentRequest,
  requestCapBytes: number,
): MaterializedHttpRequest => materialize(template, request, requestCapBytes);

/** Materializes a request sent outside any case, such as a background agent's shutdown call. */
const materializeStaticRequest = (
  template: ResolvedHttpRequestTemplate,
  requestCapBytes: number,
): MaterializedHttpRequest => materialize(template, undefined, requestCapBytes);

export {
  assertStaticUrlAuthority,
  materializeHttpRequest,
  materializeStaticRequest,
  resolveRequestTemplate,
  type RequestTemplateOverrides,
  type MaterializedHttpRequest,
  type ResolvedHttpRequestTemplate,
};
