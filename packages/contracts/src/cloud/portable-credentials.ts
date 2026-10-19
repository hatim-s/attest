import type { z } from 'zod';

import type { ProjectResources } from '../project/resources-snapshot.js';
import type { HttpRequestTemplate } from '../project/resources/agent-transports.js';
import { isString, type SecretReference } from '../project/shared.js';

const credentialKey =
  /(?:^|[-_])(?:authorization|cookie|secret|password|api[-_]?key)(?:$|[-_])|^token$/iu;

/** Portable revisions cannot depend on local files or persist credentials in transport fields. */
const refinePortableCredentials = (resources: ProjectResources, context: z.RefinementCtx): void => {
  const report = (path: (string | number)[], message: string) =>
    context.addIssue({ code: 'custom', path: ['resources', ...path], message });

  const checkUrl = (value: string, path: (string | number)[]) => {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return;
    }

    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => credentialKey.test(key))
    )
      report(path, 'portable URLs must not contain credentials');

    return url;
  };

  const checkEnvironment = (
    env: Record<string, SecretReference> | undefined,
    path: (string | number)[],
  ) => {
    for (const [key, reference] of Object.entries(env ?? {}))
      if ('from_file' in reference)
        report([...path, key], 'portable secrets must use environment references');
  };

  const checkFields = (
    request: Pick<HttpRequestTemplate, 'url' | 'headers' | 'query'>,
    path: (string | number)[],
  ) => {
    for (const field of ['headers', 'query'] as const) {
      for (const [key, value] of Object.entries(request[field] ?? {})) {
        if (isString(value)) {
          if (credentialKey.test(key))
            report([...path, field, key], 'credential fields must use environment references');
        } else if ('from_file' in value) {
          report([...path, field, key], 'portable secrets must use environment references');
        }
      }
    }
  };

  const checkRequest = (request: HttpRequestTemplate, path: (string | number)[]) => {
    const url = checkUrl(request.url, [...path, 'url']);

    if (url?.search)
      report([...path, 'url'], 'portable HTTP request URLs must not contain query strings');
    checkFields(request, path);
  };

  resources.agents.forEach(({ transport }, index) => {
    const path = ['agents', index, 'transport'];

    switch (transport.kind) {
      case 'http':
      case 'stream':
        checkRequest(transport.request, [...path, 'request']);
        break;
      case 'polling':
        checkRequest(transport.submit, [...path, 'submit']);

        if (transport.status_url_template !== undefined)
          checkUrl(transport.status_url_template, [...path, 'status_url_template']);
        break;
      case 'callback':
        checkRequest(transport.trigger, [...path, 'trigger']);

        for (const field of ['artifact_fetch', 'trace_fetch'] as const) {
          const request = transport[field];

          if (request !== undefined) checkRequest(request, [...path, field]);
        }

        if (transport.receiver?.public_url !== undefined)
          checkUrl(transport.receiver.public_url, [...path, 'receiver', 'public_url']);
        break;
      case 'websocket':
        checkUrl(transport.url, [...path, 'url']);
        checkFields(transport, path);
        break;
      case 'background_cli':
        checkRequest(transport.invoke, [...path, 'invoke']);

        if (transport.shutdown !== undefined)
          checkRequest(transport.shutdown, [...path, 'shutdown']);

        if (transport.readiness.kind === 'http')
          checkUrl(transport.readiness.url, [...path, 'readiness', 'url']);
        checkEnvironment(transport.env, [...path, 'env']);
        break;
      case 'native_cli':
      case 'jsonl_bridge':
        checkEnvironment(transport.env, [...path, 'env']);
        break;
      default: {
        const exhaustive: never = transport;

        return exhaustive;
      }
    }
  });

  resources.metrics.forEach(({ definition }, index) => {
    const path = ['metrics', index, 'definition'];

    if (definition.kind === 'http') checkRequest(definition.request, [...path, 'request']);

    if (definition.kind === 'exec') checkEnvironment(definition.env, [...path, 'env']);
  });
};

export { refinePortableCredentials };
