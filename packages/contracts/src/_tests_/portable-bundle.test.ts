import { describe, expect, it } from 'vitest';

import {
  portableProjectBundleSchema,
  type PortableProjectBundle,
} from '../cloud/project-bundle.js';
import type { AgentTransport, HttpRequestTemplate } from '../project/resources/agent-transports.js';
import { compileGeneratedSchema } from './support/compile-generated-schema.js';

const emptyBundle = {
  schema: 'attest.project-bundle.v1',
  resources: {
    project: {
      schema: 'attest.project',
      project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'Portable',
      resources: { agents: [], tests: [], datasets: [], metrics: [] },
    },
    agents: [],
    tests: [],
    datasets: [],
    metrics: [],
  },
  files: {},
} satisfies PortableProjectBundle;

const request = { url: 'https://agent.example/invoke', method: 'POST' } as const;

const extraction = { result_pointer: '/result' };

const transports: AgentTransport[] = [
  { kind: 'http', lifecycle: 'external', response_mode: 'mapped', request, extraction },
  {
    kind: 'stream',
    lifecycle: 'external',
    framing: 'jsonl',
    request,
    terminal_pointer: '/done',
    terminal_values: [true],
    result_pointer: '/result',
  },
  {
    kind: 'polling',
    lifecycle: 'external',
    submit: request,
    job_id_pointer: '/id',
    status_url_template: 'https://agent.example/jobs/{{job_id}}',
    status_pointer: '/status',
    success_values: ['done'],
    failure_values: ['failed'],
    extraction,
    minimum_interval_ms: 1,
    maximum_interval_ms: 2,
  },
  {
    kind: 'background_cli',
    lifecycle: 'per_run',
    start_argv: ['agent'],
    readiness: { kind: 'http', url: 'http://localhost/ready' },
    invoke: request,
    shutdown: request,
    extraction,
    stop_timeout_ms: 1,
  },
  {
    kind: 'websocket',
    lifecycle: 'per_case',
    connection_mode: 'serial',
    framing: 'text_json',
    url: 'wss://agent.example/invoke',
    request_template: { id: '{{request_id}}' },
    request_id_pointer: '/id',
    acknowledgement_pointer: '/ack',
    acknowledgement_values: [true],
    result_pointer: '/result',
    error_pointer: '/error',
    open_timeout_ms: 1,
    message_idle_timeout_ms: 2,
    attempt_timeout_ms: 3,
    ping_interval_ms: 1,
    close_timeout_ms: 1,
    retry_boundary: 'before_acknowledgement',
    replay_after_acknowledgement: false,
  },
  { kind: 'native_cli', lifecycle: 'per_case', argv: ['agent'] },
  {
    kind: 'jsonl_bridge',
    lifecycle: 'per_run',
    argv: ['agent'],
    concurrency: 'serial',
    cancellation_grace_ms: 1,
  },
];

const withTransport = (transport: AgentTransport): PortableProjectBundle => ({
  ...emptyBundle,
  resources: {
    ...emptyBundle.resources,
    project: {
      ...emptyBundle.resources.project,
      resources: {
        ...emptyBundle.resources.project.resources,
        agents: [
          {
            id: 'agent',
            schema: 'attest.agent',
            path: 'attest/agents/agent.json',
            content_hash: 'a'.repeat(64),
          },
        ],
      },
    },
    agents: [{ schema: 'attest.agent', id: 'agent', name: 'Agent', transport }],
  },
});

const filesOf = (count: number, value: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`attest/metrics/code/file-${index}.ts`, value]),
  );

const expectIssue = (
  candidate: PortableProjectBundle,
  path: (string | number)[],
  message: string,
) => {
  const result = portableProjectBundleSchema.safeParse(candidate);
  expect(result.success).toBe(false);

  if (!result.success)
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ['resources', ...path], message }),
    );
};

describe('portable bundle limits and credentials', () => {
  it.each(transports)(
    'accepts environment-backed $kind transport and rejects local secrets',
    (transport) => {
      expect(portableProjectBundleSchema.safeParse(withTransport(transport)).success).toBe(true);

      if (
        transport.kind === 'native_cli' ||
        transport.kind === 'jsonl_bridge' ||
        transport.kind === 'background_cli'
      ) {
        expect(
          portableProjectBundleSchema.safeParse(
            withTransport({ ...transport, env: { TOKEN: { from_env: 'TOKEN' } } }),
          ).success,
        ).toBe(true);
        expectIssue(
          withTransport({ ...transport, env: { TOKEN: { from_file: 'token.txt' } } }),
          ['agents', 0, 'transport', 'env', 'TOKEN'],
          'portable secrets must use environment references',
        );
      }

      for (const field of ['request', 'submit', 'invoke', 'shutdown'] as const) {
        if (!(field in transport)) continue;

        for (const [badRequest, issuePath, message] of [
          [
            { ...request, url: 'https://user:pass@agent.example/invoke' },
            ['url'],
            'portable URLs must not contain credentials',
          ],
          [
            { ...request, url: 'https://agent.example/invoke?page=1' },
            ['url'],
            'portable HTTP request URLs must not contain query strings',
          ],
          [
            { ...request, headers: { 'X-Api-Key': 'secret' } },
            ['headers', 'X-Api-Key'],
            'credential fields must use environment references',
          ],
          [
            { ...request, query: { token: 'secret' } },
            ['query', 'token'],
            'credential fields must use environment references',
          ],
          [
            { ...request, headers: { Accept: { from_file: 'header.txt' } } },
            ['headers', 'Accept'],
            'portable secrets must use environment references',
          ],
          [
            { ...request, query: { page: { from_file: 'query.txt' } } },
            ['query', 'page'],
            'portable secrets must use environment references',
          ],
        ] satisfies [HttpRequestTemplate, string[], string][])
          expectIssue(
            withTransport({ ...transport, [field]: badRequest }),
            ['agents', 0, 'transport', field, ...issuePath],
            message,
          );
        expect(
          portableProjectBundleSchema.safeParse(
            withTransport({
              ...transport,
              [field]: { ...request, headers: { Authorization: { from_env: 'TOKEN' } } },
            }),
          ).success,
        ).toBe(true);
      }

      if (transport.kind === 'websocket') {
        for (const [change, path, message] of [
          [
            { url: 'wss://agent.example/invoke?token=secret' },
            ['url'],
            'portable URLs must not contain credentials',
          ],
          [
            { url: 'wss://user:pass@agent.example/invoke' },
            ['url'],
            'portable URLs must not contain credentials',
          ],
          [
            { headers: { 'X-Api-Key': 'secret' } },
            ['headers', 'X-Api-Key'],
            'credential fields must use environment references',
          ],
          [
            { headers: { Accept: { from_file: 'header.txt' } } },
            ['headers', 'Accept'],
            'portable secrets must use environment references',
          ],
        ] satisfies [Partial<Extract<AgentTransport, { kind: 'websocket' }>>, string[], string][])
          expectIssue(
            withTransport({ ...transport, ...change }),
            ['agents', 0, 'transport', ...path],
            message,
          );
        expect(
          portableProjectBundleSchema.safeParse(
            withTransport({
              ...transport,
              url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
            }),
          ).success,
        ).toBe(true);
      }

      if (transport.kind === 'polling') {
        expectIssue(
          withTransport({
            ...transport,
            status_url_template: 'https://agent.example/status?token=secret',
          }),
          ['agents', 0, 'transport', 'status_url_template'],
          'portable URLs must not contain credentials',
        );
        expect(
          portableProjectBundleSchema.safeParse(
            withTransport({
              ...transport,
              status_url_template: 'https://agent.example/jobs?id={{job_id}}',
            }),
          ).success,
        ).toBe(true);
      }

      if (transport.kind === 'background_cli') {
        expectIssue(
          withTransport({
            ...transport,
            readiness: { kind: 'http', url: 'http://localhost/ready?token=secret' },
          }),
          ['agents', 0, 'transport', 'readiness', 'url'],
          'portable URLs must not contain credentials',
        );
        expect(
          portableProjectBundleSchema.safeParse(
            withTransport({
              ...transport,
              readiness: { kind: 'http', url: 'http://localhost/ready?probe=health' },
            }),
          ).success,
        ).toBe(true);
      }
    },
  );

  it('requires environment references for HTTP and executable metric credentials', () => {
    const withMetric = (
      definition: PortableProjectBundle['resources']['metrics'][number]['definition'],
    ): PortableProjectBundle => ({
      ...emptyBundle,
      resources: {
        ...emptyBundle.resources,
        project: {
          ...emptyBundle.resources.project,
          resources: {
            ...emptyBundle.resources.project.resources,
            metrics: [
              {
                id: 'metric',
                schema: 'attest.metric',
                path: 'attest/metrics/metric.json',
                content_hash: 'a'.repeat(64),
              },
            ],
          },
        },
        metrics: [{ schema: 'attest.metric', id: 'metric', name: 'Metric', definition }],
      },
    });

    expect(
      portableProjectBundleSchema.safeParse(
        withMetric({ kind: 'exec', argv: ['metric'], env: { TOKEN: { from_env: 'TOKEN' } } }),
      ).success,
    ).toBe(true);
    expectIssue(
      withMetric({ kind: 'exec', argv: ['metric'], env: { TOKEN: { from_file: 'token.txt' } } }),
      ['metrics', 0, 'definition', 'env', 'TOKEN'],
      'portable secrets must use environment references',
    );
    expect(
      portableProjectBundleSchema.safeParse(
        withMetric({
          kind: 'http',
          request: { ...request, headers: { Authorization: { from_env: 'TOKEN' } } },
          extraction: { score_pointer: '/score', pass_pointer: '/pass' },
        }),
      ).success,
    ).toBe(true);

    for (const [badRequest, path, message] of [
      [
        { ...request, url: 'https://user:password@agent.example/metric' },
        ['url'],
        'portable URLs must not contain credentials',
      ],
      [
        { ...request, url: 'https://agent.example/metric?page=1' },
        ['url'],
        'portable HTTP request URLs must not contain query strings',
      ],
      [
        { ...request, query: { token: 'secret' } },
        ['query', 'token'],
        'credential fields must use environment references',
      ],
      [
        { ...request, headers: { Authorization: { from_file: 'token.txt' } } },
        ['headers', 'Authorization'],
        'portable secrets must use environment references',
      ],
    ] satisfies [HttpRequestTemplate, string[], string][])
      expectIssue(
        withMetric({
          kind: 'http',
          request: badRequest,
          extraction: { score_pointer: '/score', pass_pointer: '/pass' },
        }),
        ['metrics', 0, 'definition', 'request', ...path],
        message,
      );
  });

  it('agrees with generated schema on the file count boundary', () => {
    const validate = compileGeneratedSchema('project-bundle.json');

    for (const [count, valid] of [
      [100, true],
      [101, false],
    ] as const) {
      const candidate = { ...emptyBundle, files: filesOf(count, '') };
      expect(portableProjectBundleSchema.safeParse(candidate).success).toBe(valid);
      expect(validate(candidate)).toBe(valid);
    }
  });

  it.each([
    [
      'UTF-8 per-file overflow',
      filesOf(1, 'é'.repeat(524_289)),
      ['files', 'attest/metrics/code/file-0.ts'],
      'must be UTF-8 text without NUL bytes and at most 1 MiB',
    ],
    [
      'NUL bytes',
      filesOf(1, '\0'),
      ['files', 'attest/metrics/code/file-0.ts'],
      'must be UTF-8 text without NUL bytes and at most 1 MiB',
    ],
    [
      'decoded total overflow',
      filesOf(6, 'a'.repeat(900_000)),
      ['files'],
      'bundle files must total at most 5 MiB',
    ],
  ])('keeps %s as a runtime-only check', (_name, files, path, message) => {
    const candidate = { ...emptyBundle, files };
    const result = portableProjectBundleSchema.safeParse(candidate);
    expect(result.success).toBe(false);

    if (!result.success)
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path, message }));
    expect(compileGeneratedSchema('project-bundle.json')(candidate)).toBe(true);
  });

  it('leaves serialized escaping limits to the upload request owner', () => {
    expect(
      portableProjectBundleSchema.safeParse({
        ...emptyBundle,
        files: filesOf(5, '\n'.repeat(600_000)),
      }).success,
    ).toBe(true);
  });

  it('accepts exactly 1 MiB of multibyte file text', () => {
    expect(
      portableProjectBundleSchema.safeParse({
        ...emptyBundle,
        files: filesOf(1, 'é'.repeat(524_288)),
      }).success,
    ).toBe(true);
  });
});
