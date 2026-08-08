import type { HttpRequestTemplate, JsonValue, SecretReference } from '@attest/contracts';

type CurlPlaceholderMapping = { inputPointer: string; targetPointer: string };

type CurlParserOptions = {
  bodyFile?: { path: string; text: string };
  headerSecrets?: Readonly<Record<string, string>>;
  placeholders?: readonly CurlPlaceholderMapping[];
  querySecrets?: Readonly<Record<string, string>>;
};

type CurlImportPreview = {
  body: JsonValue | null;
  body_encoding: 'json' | 'raw' | null;
  headers: Record<string, string>;
  method: HttpRequestTemplate['method'];
  query: Record<string, string>;
  url: string;
};

type ParsedCurlCommand = {
  preview: CurlImportPreview;
  request: HttpRequestTemplate;
};

class CurlImportError extends Error {
  readonly diagnostics: string[];

  constructor(message: string, diagnostics: readonly string[]) {
    super(message);
    this.name = 'CurlImportError';
    this.diagnostics = [...diagnostics];
  }
}

const SENSITIVE_NAME = /authorization|cookie|password|secret|token|api[-_]?key/iu;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const METHODS = new Set<HttpRequestTemplate['method']>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const UNSUPPORTED_VALUE_FLAGS = new Set([
  '--anyauth',
  '--aws-sigv4',
  '--cert',
  '--cert-type',
  '--config',
  '--connect-to',
  '--cookie',
  '--cookie-jar',
  '--data-binary',
  '--form',
  '--form-string',
  '--ftp-account',
  '--key',
  '--key-type',
  '--netrc-file',
  '--oauth2-bearer',
  '--pass',
  '--preproxy',
  '--proxy',
  '--proxy-header',
  '--proxy-user',
  '--resolve',
  '--upload-file',
  '--user',
  '-F',
  '-T',
  '-b',
  '-c',
  '-u',
  '-x',
]);
const UNSUPPORTED_BOOLEAN_FLAGS = new Set([
  '--location',
  '--location-trusted',
  '--netrc',
  '--netrc-optional',
  '--path-as-is',
  '--remote-name',
  '--remote-header-name',
  '--remote-name-all',
  '--upload-flags',
  '-L',
  '-O',
]);
const IGNORED_FLAGS = new Set([
  '--compressed',
  '--fail-with-body',
  '--show-error',
  '--silent',
  '-S',
  '-s',
]);

type TokenizeState = {
  quote?: 'double' | 'single';
  token: string;
  tokenStarted: boolean;
  tokens: string[];
};

const pushToken = (state: TokenizeState): void => {
  if (!state.tokenStarted) return;
  state.tokens.push(state.token);
  state.token = '';
  state.tokenStarted = false;
};

/** Tokenizes a cURL command as inert data and rejects every shell control construct. */
const tokenizeCurl = (source: string): string[] => {
  const state: TokenizeState = { token: '', tokenStarted: false, tokens: [] };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === '`' || (character === '$' && ['(', '{'].includes(next ?? ''))) {
      throw new CurlImportError('The cURL input contains shell expansion.', ['shell_expansion']);
    }
    if (state.quote === 'single') {
      if (character === "'") state.quote = undefined;
      else state.token += character;
      state.tokenStarted = true;
      continue;
    }
    if (state.quote === 'double') {
      if (character === '"') state.quote = undefined;
      else if (character === '\\' && next !== undefined) state.token += source[++index]!;
      else state.token += character;
      state.tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      state.quote = character === "'" ? 'single' : 'double';
      state.tokenStarted = true;
      continue;
    }
    if (character === '\\' && (next === '\n' || (next === '\r' && source[index + 2] === '\n'))) {
      index += next === '\r' ? 2 : 1;
      continue;
    }
    if (character === '\\' && next !== undefined) {
      state.token += source[++index]!;
      state.tokenStarted = true;
      continue;
    }
    if (
      character === ';' ||
      character === '|' ||
      character === '<' ||
      character === '>' ||
      (character === '&' && next === '&')
    ) {
      throw new CurlImportError('The cURL input contains shell control syntax.', ['shell_control']);
    }
    if (/\s/u.test(character)) pushToken(state);
    else {
      state.token += character;
      state.tokenStarted = true;
    }
  }
  if (state.quote !== undefined) {
    throw new CurlImportError('The cURL input contains an unclosed quote.', ['unclosed_quote']);
  }
  pushToken(state);
  return state.tokens;
};

const optionValue = (tokens: readonly string[], index: number, flag: string): string => {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CurlImportError(`cURL option ${flag} is missing its value.`, [
      `missing_value:${flag}`,
    ]);
  }
  return value;
};

const normalizedSecretMap = (
  bindings: Readonly<Record<string, string>> | undefined,
): Map<string, string> =>
  new Map(
    Object.entries(bindings ?? {}).map(([name, environment]) => [name.toLowerCase(), environment]),
  );

const secretReference = (environment: string): SecretReference => ({ from_env: environment });

const parseHeader = (
  raw: string,
  headers: Record<string, string | SecretReference>,
  secretHeaders: Map<string, string>,
): void => {
  const separator = raw.indexOf(':');
  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  const normalized = name.toLowerCase();
  if (separator <= 0 || !HEADER_NAME.test(name) || /[\r\n]/u.test(value)) {
    throw new CurlImportError('The cURL input contains an invalid header.', ['invalid_header']);
  }
  if (Object.keys(headers).some((candidate) => candidate.toLowerCase() === normalized)) {
    throw new CurlImportError('The cURL input contains an ambiguous duplicate header.', [
      `duplicate_header:${normalized}`,
    ]);
  }
  const environment = secretHeaders.get(normalized);
  if (SENSITIVE_NAME.test(name) && environment === undefined) {
    throw new CurlImportError('A sensitive cURL header needs an environment reference.', [
      `unsafe_header:${normalized}`,
    ]);
  }
  headers[name] = environment === undefined ? value : secretReference(environment);
};

const pointerTokens = (pointer: string): string[] =>
  pointer === ''
    ? []
    : pointer
        .slice(1)
        .split('/')
        .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));

/** Rejects credential-shaped JSON fields because body secret resolution is intentionally unsupported. */
const assertNoSensitiveBodyFields = (value: JsonValue): void => {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveBodyFields(entry);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [name, entry] of Object.entries(value)) {
    if (SENSITIVE_NAME.test(name)) {
      throw new CurlImportError('The cURL body contains an unsafe credential field.', [
        `unsafe_body_field:${name.toLowerCase()}`,
      ]);
    }
    assertNoSensitiveBodyFields(entry);
  }
};

/** Replaces one existing JSON target with a typed input placeholder and never creates guessed paths. */
const applyPlaceholder = (body: JsonValue, mapping: CurlPlaceholderMapping): void => {
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/u.test(mapping.targetPointer) || mapping.targetPointer === '') {
    throw new CurlImportError('A cURL body mapping target is invalid.', ['invalid_target_pointer']);
  }
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/u.test(mapping.inputPointer)) {
    throw new CurlImportError('A cURL input mapping pointer is invalid.', [
      'invalid_input_pointer',
    ]);
  }
  const tokens = pointerTokens(mapping.targetPointer);
  const final = tokens.pop()!;
  let parent: JsonValue = body;
  for (const token of tokens) {
    if (Array.isArray(parent) && /^(?:0|[1-9]\d*)$/u.test(token)) parent = parent[Number(token)]!;
    else if (
      parent !== null &&
      typeof parent === 'object' &&
      !Array.isArray(parent) &&
      Object.hasOwn(parent, token)
    ) {
      parent = (parent as Record<string, JsonValue>)[token]!;
    } else {
      throw new CurlImportError('A cURL body mapping target does not exist.', [
        'missing_target_pointer',
      ]);
    }
  }
  const placeholder = `{{input${mapping.inputPointer}}}`;
  if (Array.isArray(parent) && /^(?:0|[1-9]\d*)$/u.test(final) && Number(final) < parent.length) {
    parent[Number(final)] = placeholder;
  } else if (
    parent !== null &&
    typeof parent === 'object' &&
    !Array.isArray(parent) &&
    Object.hasOwn(parent, final)
  ) {
    (parent as Record<string, JsonValue>)[final] = placeholder;
  } else {
    throw new CurlImportError('A cURL body mapping target does not exist.', [
      'missing_target_pointer',
    ]);
  }
};

/** Locates the one cURL data file reference without reading or executing it. */
const findCurlBodyFilePath = (source: string): string | undefined => {
  const tokens = tokenizeCurl(source.trim());
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (['-d', '--data', '--data-ascii'].includes(token)) {
      const value = optionValue(tokens, index, token);
      if (value.startsWith('@')) return value.slice(1);
      index += 1;
      continue;
    }
    if (
      UNSUPPORTED_VALUE_FLAGS.has(token) ||
      ['-X', '--request', '-H', '--header', '--data-raw', '--url'].includes(token)
    ) {
      index += 1;
    }
  }
  return undefined;
};

const contentType = (headers: Readonly<Record<string, string | SecretReference>>): string => {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
  return typeof entry?.[1] === 'string' ? entry[1].toLowerCase() : '';
};

/** Applies pointer-shaped mappings to unique form fields while preserving form wire encoding. */
const mapFormBody = (body: string, mappings: readonly CurlPlaceholderMapping[]): string => {
  const form = new URLSearchParams(body);
  for (const name of form.keys()) {
    if (SENSITIVE_NAME.test(name)) {
      throw new CurlImportError('The cURL form body contains an unsafe credential field.', [
        `unsafe_body_field:${name.toLowerCase()}`,
      ]);
    }
  }
  if (mappings.length === 0) return body;
  for (const mapping of mappings) {
    const tokens = pointerTokens(mapping.targetPointer);
    if (tokens.length !== 1 || !form.has(tokens[0]!) || form.getAll(tokens[0]!).length !== 1) {
      throw new CurlImportError('A form body mapping target is missing or ambiguous.', [
        'invalid_form_target',
      ]);
    }
    form.set(tokens[0]!, `{{input${mapping.inputPointer}}}`);
  }
  return mappings.reduce((serialized, mapping) => {
    const placeholder = `{{input${mapping.inputPointer}}}`;
    return serialized.replaceAll(encodeURIComponent(placeholder), placeholder);
  }, form.toString());
};

/** Parses one cURL command into a strict, secret-reference-only HTTP request template. */
const parseCurlCommand = (source: string, options: CurlParserOptions = {}): ParsedCurlCommand => {
  const tokens = tokenizeCurl(source.trim());
  if (tokens[0] !== 'curl') {
    throw new CurlImportError('The import must contain exactly one cURL command.', [
      'missing_curl',
    ]);
  }
  const unsupported: string[] = [];
  const headers: Record<string, string | SecretReference> = {};
  const secretHeaders = normalizedSecretMap(options.headerSecrets);
  let method: HttpRequestTemplate['method'] | undefined;
  let rawBody: string | undefined;
  let bodyFilePath: string | undefined;
  let rawUrl: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (IGNORED_FLAGS.has(token)) continue;
    if (UNSUPPORTED_VALUE_FLAGS.has(token)) {
      unsupported.push(token);
      index += 1;
      continue;
    }
    if (UNSUPPORTED_BOOLEAN_FLAGS.has(token)) {
      unsupported.push(token);
      continue;
    }
    if (['-X', '--request'].includes(token)) {
      const value = optionValue(tokens, index, token).toUpperCase();
      index += 1;
      if (!METHODS.has(value as HttpRequestTemplate['method']))
        unsupported.push(`${token}:${value}`);
      else if (method !== undefined && method !== value) unsupported.push('ambiguous_method');
      else method = value as HttpRequestTemplate['method'];
      continue;
    }
    if (['-H', '--header'].includes(token)) {
      parseHeader(optionValue(tokens, index, token), headers, secretHeaders);
      index += 1;
      continue;
    }
    if (['-d', '--data', '--data-raw', '--data-ascii'].includes(token)) {
      const value = optionValue(tokens, index, token);
      index += 1;
      if (rawBody !== undefined) unsupported.push('ambiguous_body');
      else if (bodyFilePath !== undefined) unsupported.push('ambiguous_body');
      else if (token !== '--data-raw' && value.startsWith('@')) bodyFilePath = value.slice(1);
      else rawBody = value;
      continue;
    }
    if (token === '--url') {
      const value = optionValue(tokens, index, token);
      index += 1;
      if (rawUrl !== undefined) unsupported.push('ambiguous_url');
      else rawUrl = value;
      continue;
    }
    if (token.startsWith('-')) {
      unsupported.push(token.split('=')[0]!);
      continue;
    }
    if (rawUrl !== undefined) unsupported.push('ambiguous_url');
    else rawUrl = token;
  }
  if (unsupported.length > 0) {
    throw new CurlImportError('The cURL input uses unsupported or ambiguous options.', [
      ...new Set(unsupported),
    ]);
  }
  if (rawUrl === undefined)
    throw new CurlImportError('The cURL input has no URL.', ['missing_url']);
  if (bodyFilePath !== undefined) {
    if (options.bodyFile?.path !== bodyFilePath) {
      throw new CurlImportError('The cURL body file must be resolved by the importer.', [
        `file_body:${bodyFilePath}`,
      ]);
    }
    rawBody = options.bodyFile.text;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error: unknown) {
    throw new CurlImportError('The cURL URL is invalid.', [
      error instanceof Error ? 'invalid_url' : 'invalid_url_value',
    ]);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new CurlImportError('The cURL URL contains an unsafe component.', ['unsafe_url']);
  }
  const query: Record<string, string | SecretReference> = {};
  const secretQuery = normalizedSecretMap(options.querySecrets);
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(query, name)) {
      throw new CurlImportError('The cURL URL contains an ambiguous duplicate query value.', [
        `duplicate_query:${name}`,
      ]);
    }
    const environment = secretQuery.get(name.toLowerCase());
    if (SENSITIVE_NAME.test(name) && environment === undefined) {
      throw new CurlImportError('A sensitive cURL query needs an environment reference.', [
        `unsafe_query:${name}`,
      ]);
    }
    query[name] = environment === undefined ? value : secretReference(environment);
  }
  url.search = '';

  let body: JsonValue | undefined;
  let bodyEncoding: 'json' | 'raw' | undefined;
  if (rawBody !== undefined) {
    const mediaType = contentType(headers);
    const formEncoded = mediaType.startsWith('application/x-www-form-urlencoded');
    let parsedJson: JsonValue | undefined;
    if (!formEncoded) {
      try {
        parsedJson = JSON.parse(rawBody) as JsonValue;
      } catch {
        parsedJson = undefined;
      }
    }
    if (
      parsedJson !== undefined &&
      (mediaType.length === 0 || /(?:\/|\+)json(?:;|$)/u.test(mediaType))
    ) {
      body = parsedJson;
      assertNoSensitiveBodyFields(body);
      for (const mapping of options.placeholders ?? []) applyPlaceholder(body, mapping);
      bodyEncoding = 'json';
    } else if (formEncoded) {
      body = mapFormBody(rawBody, options.placeholders ?? []);
      bodyEncoding = 'raw';
    } else {
      if ((options.placeholders?.length ?? 0) > 0) {
        throw new CurlImportError('Raw cURL bodies do not support JSON Pointer mappings.', [
          'raw_body_mapping',
        ]);
      }
      if (SENSITIVE_NAME.test(rawBody)) {
        throw new CurlImportError('The raw cURL body may contain an unsafe credential.', [
          'unsafe_raw_body',
        ]);
      }
      body = rawBody;
      bodyEncoding = 'raw';
    }
  } else if ((options.placeholders?.length ?? 0) > 0) {
    throw new CurlImportError('Body mappings require a cURL body.', ['missing_body']);
  }

  const resolvedMethod = method ?? (body === undefined ? 'GET' : 'POST');
  const request: HttpRequestTemplate = {
    url: url.toString(),
    method: resolvedMethod,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(Object.keys(query).length === 0 ? {} : { query }),
    ...(body === undefined ? {} : { body }),
    ...(bodyEncoding === undefined ? {} : { body_encoding: bodyEncoding }),
  };
  const redactTemplateValue = (value: string | SecretReference): string =>
    typeof value === 'string'
      ? value
      : 'from_env' in value
        ? `[from_env:${value.from_env}]`
        : '[from_file]';
  return {
    request,
    preview: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, redactTemplateValue(value)]),
      ),
      query: Object.fromEntries(
        Object.entries(query).map(([name, value]) => [name, redactTemplateValue(value)]),
      ),
      body: body ?? null,
      body_encoding: bodyEncoding ?? null,
    },
  };
};

export {
  CurlImportError,
  findCurlBodyFilePath,
  parseCurlCommand,
  type CurlImportPreview,
  type CurlParserOptions,
  type CurlPlaceholderMapping,
  type ParsedCurlCommand,
};
