import type { AgentRequest, HttpRequestTemplate, JsonValue } from '@attest/contracts';

import { AgentInvocationError } from '../../errors.js';
import { readJsonPointer } from './json-pointer.js';

type ResolvedHttpRequestTemplate = Omit<HttpRequestTemplate, 'headers' | 'query'> & {
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

type MaterializedHttpRequest = {
  body?: string;
  headers: Record<string, string>;
  method: HttpRequestTemplate['method'];
  url: string;
};

const PLACEHOLDER = /\{\{(input|request)((?:\/(?:[^~/]|~[01])*)*)\}\}/gu;

const placeholderValue = (request: AgentRequest, root: string, pointer: string): unknown =>
  readJsonPointer(root === 'input' ? request.input : request, pointer);

const scalarText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new AgentInvocationError(
    'invalid_envelope',
    'HTTP path, query, and header placeholders must resolve to JSON scalars.',
  );
};

const interpolateText = (template: string, request: AgentRequest, encode: boolean): string =>
  template.replaceAll(PLACEHOLDER, (_match, root: string, pointer: string) => {
    const value = placeholderValue(request, root, pointer);
    if (value === undefined) {
      throw new AgentInvocationError('invalid_envelope', 'An HTTP request placeholder is missing.');
    }
    const text = scalarText(value);
    return encode ? encodeURIComponent(text) : text;
  });

const mapBodyValue = (value: JsonValue, request: AgentRequest): JsonValue => {
  if (typeof value === 'string') {
    const exact = /^\{\{(input|request)((?:\/(?:[^~/]|~[01])*)*)\}\}$/u.exec(value);
    if (exact !== null) {
      const mapped = placeholderValue(request, exact[1]!, exact[2]!);
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

/** Materializes one mapped request while encoding URL substitutions and preserving JSON body types. */
const materializeHttpRequest = (
  template: ResolvedHttpRequestTemplate,
  request: AgentRequest,
  requestCapBytes: number,
): MaterializedHttpRequest => {
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
  const body = bodyValue === undefined ? undefined : JSON.stringify(bodyValue);
  if (body !== undefined && Buffer.byteLength(body) > requestCapBytes) {
    throw new AgentInvocationError(
      'output_cap_exceeded',
      `Mapped HTTP request exceeds the ${requestCapBytes}-byte request cap.`,
    );
  }
  if (
    body !== undefined &&
    !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  ) {
    headers['content-type'] = 'application/json';
  }
  return {
    method: template.method,
    url: url.toString(),
    headers,
    ...(body === undefined ? {} : { body }),
  };
};

export { materializeHttpRequest, type MaterializedHttpRequest, type ResolvedHttpRequestTemplate };
