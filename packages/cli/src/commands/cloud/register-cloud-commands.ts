import * as Effect from 'effect/Effect';
import { randomUUID } from 'node:crypto';
import * as cloudAdapter from '@attest/local/cloud';
import { createEvalRunRequest, type EvalRunRequestFields } from '../eval/eval-request.js';
import {
  addEvalSelectionOptions,
  evalSelectionFields,
  type EvalSelectionOptions,
} from '../eval/eval-selection-options.js';
import { AttestCliError } from '../../errors/cli-error.js';
import { renderResult } from '../shared/command-result.js';
import { addCommonOptions, promptContext, type CommonCliOptions } from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';

type LoginOptions = CommonCliOptions & {
  url: Parameters<typeof cloudAdapter.loginCloud>[0]['baseUrl'];
};

type PullOptions = CommonCliOptions & {
  revision?: Parameters<typeof cloudAdapter.pullCloudProject>[0]['revisionId'];
};

type PushOptions = CommonCliOptions & {
  secrets?: boolean;
};

type RunOptions = PullOptions &
  Pick<EvalRunRequestFields, 'all' | 'sample' | 'seed' | 'concurrency' | 'timeout'> &
  EvalSelectionOptions & {
    idempotencyKey?: Parameters<typeof cloudAdapter.runCloud>[0]['idempotencyKey'];
  };

type EventsOptions = CommonCliOptions & {
  after: string;
};

/** Registers terminal translation only; the local cloud adapter owns authentication and state. */
const registerCloudCommands = ({
  signal: commandSignal,
  submit,
  program,
  io,
  workingDirectory,
  credentialPath,
  interaction,
  services,
}: CommandContext): void => {
  const {
    uploadCloudRun,
    resolveCloudUploadProject,
    createCloudProjectToken,
    listCloudProjectTokens,
    revokeCloudProjectToken,
    authenticatedCloudClient,
    cloudEvents,
    listCloudProjects,
    createCloudProject,
    getCloudRun,
    cancelCloudRun,
    getCloudRunResult,
    linkCloudProject,
    loginCloud,
    logoutCloud,
    pullCloudProject,
    pushCloudProject,
    resolveCloudProject,
    runCloud,
  } = { ...cloudAdapter, ...services?.cloud };

  const cloud = program
    .command('cloud')
    .description('Authenticate, sync projects, and manage hosted evaluations.');

  const output = <TResult>(command: string, options: CommonCliOptions, result: TResult): void => {
    io.output(
      renderResult(`cloud.${command}`, options.output ?? 'human', result, (value) =>
        JSON.stringify(value, undefined, 2),
      ),
    );
  };

  const projectContext = (options: CommonCliOptions) =>
    Effect.gen(function* () {
      return {
        workingDirectory,
        project: options.project,
        client: yield* authenticatedCloudClient(credentialPath),
      };
    });

  addCommonOptions(
    cloud
      .command('upload')
      .description('Upload a finished local run and print its dashboard URL.')
      .argument('[run-id]'),
  ).action((runId: string | undefined, options: CommonCliOptions) =>
    submit(
      Effect.gen(function* () {
        const result = yield* uploadCloudRun({
          ...(yield* resolveCloudUploadProject({
            ...(yield* projectContext(options)),
            signal: commandSignal,
          })),
          runId,
        });

        io.output(
          renderResult('cloud.upload', options.output ?? 'human', result, ({ url }) => url),
        );
      }),
    ),
  );

  const tokens = cloud
    .command('token')
    .description('Manage project upload tokens with a device session.');

  addCommonOptions(
    tokens
      .command('create')
      .description('Print a new upload token once.')
      .requiredOption('--name <name>', 'token name'),
  ).action(
    (
      options: CommonCliOptions & {
        name: string;
      },
    ) =>
      submit(
        Effect.gen(function* () {
          return output(
            'token.create',
            options,
            yield* createCloudProjectToken({
              ...(yield* projectContext(options)),
              name: options.name,
            }),
          );
        }),
      ),
  );
  addCommonOptions(tokens.command('list').description('List project token metadata.')).action(
    (options: CommonCliOptions) =>
      submit(
        Effect.gen(function* () {
          return output(
            'token.list',
            options,
            yield* listCloudProjectTokens(yield* projectContext(options)),
          );
        }),
      ),
  );
  addCommonOptions(
    tokens.command('revoke').description('Revoke a project upload token.').argument('<id>'),
  ).action((tokenId: string, options: CommonCliOptions) =>
    submit(
      Effect.gen(function* () {
        return output(
          'token.revoke',
          options,
          yield* revokeCloudProjectToken({ ...(yield* projectContext(options)), tokenId }),
        );
      }),
    ),
  );
  const projects = cloud.command('project').description('List or create cloud projects.');
  addCommonOptions(
    projects.command('list').description('List projects available to this account.'),
  ).action((options: CommonCliOptions) =>
    submit(
      Effect.gen(function* () {
        return output(
          'project.list',
          options,
          yield* listCloudProjects(yield* authenticatedCloudClient(credentialPath)),
        );
      }),
    ),
  );
  addCommonOptions(
    projects
      .command('create')
      .description('Create a project before linking a local directory.')
      .argument('<name>'),
  ).action((name: string, options: CommonCliOptions) =>
    submit(
      Effect.gen(function* () {
        return output(
          'project.create',
          options,
          yield* createCloudProject(yield* authenticatedCloudClient(credentialPath), name),
        );
      }),
    ),
  );
  addCommonOptions(
    cloud.command('login').description('Approve a revocable CLI session in your cloud account.'),
  )
    .requiredOption('--url <origin>', 'cloud HTTPS origin')
    .action((options: LoginOptions) =>
      submit(
        Effect.gen(function* () {
          const result = yield* loginCloud({
            baseUrl: options.url,
            credentialPath,
            signal: commandSignal,
            onDevice: ({ verification_uri, user_code }) =>
              io.error(`Approve CLI access at ${verification_uri}\nCode: ${user_code}`),
          });

          output('login', options, result);
        }),
      ),
    );
  addCommonOptions(
    cloud.command('logout').description('Revoke the cloud session and remove its local token.'),
  ).action((options: CommonCliOptions) =>
    submit(
      Effect.gen(function* () {
        return output('logout', options, yield* logoutCloud(credentialPath));
      }),
    ),
  );
  addCommonOptions(
    cloud
      .command('link')
      .description('Link this local project to a cloud project.')
      .argument('<project-id>'),
  ).action((projectId: string, options: CommonCliOptions) =>
    submit(
      Effect.gen(function* () {
        return output(
          'link',
          options,
          yield* linkCloudProject({ ...(yield* projectContext(options)), projectId }),
        );
      }),
    ),
  );
  addCommonOptions(
    cloud
      .command('push')
      .description(
        'Upload an immutable revision. Project definitions and datasets persist until deleted.',
      ),
  )
    .option('--no-secrets', 'confirm the project contains no secrets')
    .action((options: PushOptions) =>
      submit(
        Effect.gen(function* () {
          return output(
            'push',
            options,
            yield* pushCloudProject({
              ...(yield* projectContext(options)),
              acknowledgeNoSecrets: options.secrets === false,
            }),
          );
        }),
      ),
    );
  addCommonOptions(
    cloud.command('pull').description('Pull a cloud revision with local conflict checks.'),
  )
    .option('--revision <id>', 'specific immutable revision; default current')
    .action((options: PullOptions) =>
      submit(
        Effect.gen(function* () {
          return output(
            'pull',
            options,
            yield* pullCloudProject({
              ...(yield* projectContext(options)),
              revisionId: options.revision,
            }),
          );
        }),
      ),
    );
  addEvalSelectionOptions(
    addCommonOptions(
      cloud
        .command('run')
        .description('Submit a hosted evaluation against the linked revision.')
        .argument('[test-id...]'),
    ).option('--all', 'run all tests'),
  )
    .option('--sample <count>', 'sample the matching cases')
    .option('--seed <seed>', 'sampling seed; requires --sample')
    .option('--concurrency <count>', 'parallel cases')
    .option('--timeout <duration>', 'complete eval run timeout')
    .option('--revision <id>', 'uploaded revision; default linked revision')
    .option(
      '--idempotency-key <key>',
      'stable retry key; retain it when reconnecting after submission',
    )
    .action((testIds: string[], options: RunOptions) =>
      submit(
        Effect.gen(function* () {
          if (options.all && testIds.length)
            return yield* Effect.fail(new AttestCliError('cli_usage', 'Pass --all or test ids.'));

          if (!options.all && !testIds.length)
            return yield* Effect.fail(
              new AttestCliError('cli_missing_input', 'Pass --all or test ids.'),
            );
          const context = yield* projectContext(options);

          const project = yield* resolveCloudProject(context);

          const revisionId = options.revision ?? project.revisionId;

          if (!revisionId)
            return yield* Effect.fail(
              new AttestCliError(
                'cli_missing_input',
                'Push the project before running it in the cloud.',
              ),
            );

          const request = yield* createEvalRunRequest(
            {
              all: options.all,
              testIds,
              ...evalSelectionFields(options),
              sample: options.sample,
              seed: options.seed,
              concurrency: options.concurrency,
              timeout: options.timeout,
              output: 'json',
            },
            promptContext({ nonInteractive: true }, interaction, commandSignal),
          );

          const idempotencyKey = options.idempotencyKey ?? randomUUID();
          // Print the key before submission so a lost response can be retried safely.
          io.error(`Cloud submission retry key: ${idempotencyKey}`);

          const result = yield* runCloud({
            client: context.client,
            projectId: project.projectId,
            revisionId,
            request,
            idempotencyKey,
          });

          output('run', options, { idempotency_key: idempotencyKey, ...result });
        }),
      ),
    );

  for (const action of ['status', 'cancel', 'result'] as const) {
    addCommonOptions(
      cloud
        .command(action)
        .description(
          `${action === 'cancel' ? 'Cancel' : 'Read'} a hosted run.${action === 'result' ? ' Raw evidence expires after five days; summaries persist.' : ''}`,
        )
        .argument('<run-id>'),
    ).action((runId: string, options: CommonCliOptions) =>
      submit(
        Effect.gen(function* () {
          const context = yield* projectContext(options);

          const project = yield* resolveCloudProject(context);

          const operation = {
            status: getCloudRun,
            cancel: cancelCloudRun,
            result: getCloudRunResult,
          }[action];

          output(action, options, yield* operation(context.client, project.projectId, runId));
        }),
      ),
    );
  }

  addCommonOptions(
    cloud
      .command('events')
      .description('Read persisted events and a cursor for reconnection.')
      .argument('<run-id>'),
  )
    .option('--after <sequence>', 'last received sequence', '0')
    .action((runId: string, options: EventsOptions) =>
      submit(
        Effect.gen(function* () {
          const context = yield* projectContext(options);

          const project = yield* resolveCloudProject(context);

          output(
            'events',
            options,
            yield* cloudEvents({
              client: context.client,
              projectId: project.projectId,
              runId,
              after: Number(options.after),
            }),
          );
        }),
      ),
    );
};

export { registerCloudCommands };
