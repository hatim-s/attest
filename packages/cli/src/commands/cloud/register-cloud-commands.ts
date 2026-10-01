import { randomUUID } from 'node:crypto';
import {
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
} from '@attest/local/cloud';
import { createEvalRunRequest } from '../eval/eval-request.js';
import { AttestCliError } from '../../errors/cli-error.js';
import { renderResult } from '../shared/command-result.js';
import { addCommonOptions, collect } from '../shared/cli-options.js';
import type { CommonCliOptions } from '../shared/cli-options.js';
import type { CommandContext } from '../shared/command-context.js';
import { withProcessSignals } from '../shared/process-signals.js';

type Options = CommonCliOptions & {
  url?: string;
  revision?: string;
  all?: boolean;
  idempotencyKey?: string;
  after?: string;
  case?: string[];
  tag?: string[];
  folder?: string[];
  dataset?: string[];
  sample?: string;
  seed?: string;
  concurrency?: string;
  timeout?: string;
};

/** Registers terminal translation only; the local cloud adapter owns authentication and state. */
const registerCloudCommands = ({
  program,
  io,
  workingDirectory,
  interaction,
}: CommandContext): void => {
  const cloud = program
    .command('cloud')
    .description('Authenticate, sync projects, and manage hosted evaluations.');
  const output = (command: string, options: Options, result: unknown): void => {
    io.output(
      renderResult(`cloud.${command}`, options.output ?? 'human', result, (value) =>
        JSON.stringify(value, undefined, 2),
      ),
    );
  };
  const projectContext = async (options: Options) => ({
    workingDirectory,
    project: options.project,
    client: await authenticatedCloudClient(),
  });
  const projects = cloud.command('project').description('List or create cloud projects.');
  addCommonOptions(
    projects.command('list').description('List projects available to this account.'),
  ).action(async (options: Options) =>
    output('project.list', options, await listCloudProjects(await authenticatedCloudClient())),
  );
  addCommonOptions(
    projects
      .command('create')
      .description('Create a project before linking a local directory.')
      .argument('<name>'),
  ).action(async (name: string, options: Options) =>
    output(
      'project.create',
      options,
      await createCloudProject(await authenticatedCloudClient(), name),
    ),
  );
  addCommonOptions(
    cloud.command('login').description('Approve a revocable CLI session in your cloud account.'),
  )
    .requiredOption('--url <origin>', 'cloud HTTPS origin')
    .action(async (options: Options) => {
      const result = await withProcessSignals((signal) =>
        loginCloud({
          baseUrl: options.url!,
          signal,
          onDevice: ({ verification_uri, user_code }) =>
            io.error(`Approve CLI access at ${verification_uri}\nCode: ${user_code}`),
        }),
      );
      output('login', options, result);
    });
  addCommonOptions(
    cloud.command('logout').description('Revoke the cloud session and remove its local token.'),
  ).action(async (options: Options) => output('logout', options, await logoutCloud()));
  addCommonOptions(
    cloud
      .command('link')
      .description('Link this local project to a cloud project.')
      .argument('<project-id>'),
  ).action(async (projectId: string, options: Options) =>
    output(
      'link',
      options,
      await linkCloudProject({ ...(await projectContext(options)), projectId }),
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
    .action(async (options: Options & { secrets?: boolean }) =>
      output(
        'push',
        options,
        await pushCloudProject({
          ...(await projectContext(options)),
          acknowledgeNoSecrets: options.secrets === false,
        }),
      ),
    );
  addCommonOptions(
    cloud.command('pull').description('Pull a cloud revision with local conflict checks.'),
  )
    .option('--revision <id>', 'specific immutable revision; default current')
    .action(async (options: Options) =>
      output(
        'pull',
        options,
        await pullCloudProject({
          ...(await projectContext(options)),
          revisionId: options.revision,
        }),
      ),
    );
  addCommonOptions(
    cloud
      .command('run')
      .description('Submit a hosted evaluation against the linked revision.')
      .argument('[test-id...]'),
  )
    .option('--all', 'run all tests')
    .option('--case <id>', 'case id filter; repeatable', collect)
    .option('--tag <tag>', 'case tag filter; repeatable', collect)
    .option('--folder <folder>', 'case folder filter; repeatable', collect)
    .option('--dataset <id>', 'dataset filter; repeatable', collect)
    .option('--sample <count>', 'sample the matching cases')
    .option('--seed <seed>', 'sampling seed; requires --sample')
    .option('--concurrency <count>', 'parallel cases')
    .option('--timeout <duration>', 'complete eval run timeout')
    .option('--revision <id>', 'uploaded revision; default linked revision')
    .option(
      '--idempotency-key <key>',
      'stable retry key; retain it when reconnecting after submission',
    )
    .action(async (testIds: string[], options: Options) => {
      if (options.all && testIds.length)
        throw new AttestCliError('cli_usage', 'Pass --all or test ids.');
      if (!options.all && !testIds.length)
        throw new AttestCliError('cli_missing_input', 'Pass --all or test ids.');
      const context = await projectContext(options);
      const project = await resolveCloudProject(context);
      const revisionId = options.revision ?? project.revisionId;
      if (!revisionId)
        throw new AttestCliError(
          'cli_missing_input',
          'Push the project before running it in the cloud.',
        );
      const request = await createEvalRunRequest(
        {
          all: options.all,
          testIds,
          caseIds: options.case,
          tags: options.tag,
          folders: options.folder,
          datasetIds: options.dataset,
          sample: options.sample,
          seed: options.seed,
          concurrency: options.concurrency,
          timeout: options.timeout,
          output: 'json',
        },
        { interactive: false, prompt: interaction.prompt },
      );
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      // Print the key before submission so a lost response can be retried safely.
      io.error(`Cloud submission retry key: ${idempotencyKey}`);
      const result = await runCloud({
        client: context.client,
        projectId: project.projectId,
        revisionId,
        request,
        idempotencyKey,
      });
      output('run', options, { idempotency_key: idempotencyKey, ...result });
    });
  for (const action of ['status', 'cancel', 'result'] as const) {
    addCommonOptions(
      cloud
        .command(action)
        .description(
          `${action === 'cancel' ? 'Cancel' : 'Read'} a hosted run.${action === 'result' ? ' Raw evidence expires after five days; summaries persist.' : ''}`,
        )
        .argument('<run-id>'),
    ).action(async (runId: string, options: Options) => {
      const context = await projectContext(options);
      const project = await resolveCloudProject(context);
      const operation = { status: getCloudRun, cancel: cancelCloudRun, result: getCloudRunResult }[
        action
      ];
      output(action, options, await operation(context.client, project.projectId, runId));
    });
  }
  addCommonOptions(
    cloud
      .command('events')
      .description('Read persisted events and a cursor for reconnection.')
      .argument('<run-id>'),
  )
    .option('--after <sequence>', 'last received sequence', '0')
    .action(async (runId: string, options: Options) => {
      const context = await projectContext(options);
      const project = await resolveCloudProject(context);
      output(
        'events',
        options,
        await cloudEvents({
          client: context.client,
          projectId: project.projectId,
          runId,
          after: Number(options.after),
        }),
      );
    });
};
export { registerCloudCommands };
