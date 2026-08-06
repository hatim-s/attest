type QuickstartTemplate = {
  contents: string;
  path: string;
};

const configTemplate = `config_version: 1
project: attest-quickstart

agent:
  type: cli
  command: [node, ./agents/cli-agent.mjs]
  timeout_ms: 10000

suites:
  - name: smoke
    metrics: []
    cases:
      - id: capital-of-france
        input: { question: What is the capital of France? }
        expected: { answer: Paris }
        metrics: [capital-france]
      - id: capital-of-japan
        input: { question: What is the capital of Japan? }
        expected: { answer: Tokyo }
        metrics: [capital-japan]

metrics:
  - name: capital-france
    type: assertion
    assert:
      - equals: { path: $.output.answer, value: Paris }
  - name: capital-japan
    type: assertion
    assert:
      - equals: { path: $.output.answer, value: Tokyo }

run:
  concurrency: 2
`;

const cliAgentTemplate = `const answers = new Map([
  ['what is the capital of france?', 'Paris'],
  ['what is the capital of japan?', 'Tokyo'],
]);

/** Reads the complete single-request envelope supplied on standard input. */
const readRequest = async () => {
  let source = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) source += chunk;
  return JSON.parse(source);
};

/** Answers the deliberately tiny quickstart knowledge set. */
const answerQuestion = (question) => answers.get(String(question).toLowerCase()) ?? 'Unknown';

const request = await readRequest();
process.stdout.write(
  JSON.stringify({
    protocol: 'attest.agent/v1alpha1',
    output: { answer: answerQuestion(request.input.question) },
  }),
);
`;

const httpAgentTemplate = `import { createServer } from 'node:http';

/** Reads one JSON request body without accepting unbounded input in this example server. */
const readJson = async (request) => {
  let source = '';
  for await (const chunk of request) {
    source += chunk;
    if (source.length > 64 * 1024) throw new Error('request too large');
  }
  return JSON.parse(source);
};

const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  try {
    const envelope = await readJson(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ protocol: 'attest.agent/v1alpha1', output: envelope.input }),
    );
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'bad request' }));
  }
});

server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => {
  console.log('HTTP example agent listening on http://127.0.0.1:8787');
});
`;

const tracedAgentTemplate = `/** Reads the complete request before producing a traced response. */
const readRequest = async () => {
  let source = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) source += chunk;
  return JSON.parse(source);
};

const request = await readRequest();
const startedAt = new Date().toISOString();
const endedAt = new Date().toISOString();
process.stdout.write(
  JSON.stringify({
    protocol: 'attest.agent/v1alpha1',
    output: request.input,
    trace: {
      schema: 'attest.trace/v1alpha1',
      trace_id: \`trace-\${request.run_id}-\${request.case_id}\`,
      spans: [
        {
          span_id: 'agent-1',
          parent_span_id: null,
          name: 'agent.run',
          kind: 'agent',
          start_time: startedAt,
          end_time: endedAt,
          status: { code: 'ok' },
          attributes: { 'gen_ai.operation.name': 'invoke_agent' },
        },
      ],
    },
  }),
);
`;

const readmeTemplate = `# Attest quickstart

Run the generated CLI agent:

\`\`\`bash
attest run
\`\`\`

Run it again with a baseline using the run id printed by the first command:

\`\`\`bash
attest run --baseline <run-id>
attest diff <base-run-id> <candidate-run-id>
\`\`\`

The default SQLite store is \`.attest/runs.db\`. Add \`--format json\` for machine-readable output or \`--junit reports/attest.xml\` for CI.

The \`agents/\` folder also contains HTTP and traced examples. To try HTTP, start \`node agents/http-agent.mjs\` and replace the config's \`agent\` block with:

\`\`\`yaml
agent:
  type: http
  url: http://127.0.0.1:8787
\`\`\`
`;

const QUICKSTART_TEMPLATES: QuickstartTemplate[] = [
  { path: 'attest.config.yaml', contents: configTemplate },
  { path: 'agents/cli-agent.mjs', contents: cliAgentTemplate },
  { path: 'agents/http-agent.mjs', contents: httpAgentTemplate },
  { path: 'agents/traced-agent.mjs', contents: tracedAgentTemplate },
  { path: 'ATTEST_QUICKSTART.md', contents: readmeTemplate },
];

export { QUICKSTART_TEMPLATES, type QuickstartTemplate };
