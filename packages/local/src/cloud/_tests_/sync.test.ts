import { valueFromExit } from '../../internal/effect-exit.js';
import * as Effect from 'effect/Effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import { stripStruct } from '@attest/contracts';
import * as Schema from 'effect/Schema';
import { contentHash, EvalResolutionError } from '@attest/core';
import { LocalError } from '../../errors/local-error.js';
import { loadProject } from '../../project/project-loader/index.js';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseWithSchemaSync,
  PROJECT_SCHEMA_ID,
  AGENT_RESOURCE_SCHEMA_ID,
  portableProjectBundleSchema,
  type PortableProjectBundle,
} from '@attest/contracts';
import { createCloudClient } from '../client.js';
import { acquireProjectLock, releaseProjectLock } from '../../project/transaction/project-lock.js';
import {
  prepareTransaction,
  writeTransactionJournal,
  recoverProjectTransactions,
} from '../../project/transaction/transaction-journal.js';
import { interruptAfterFirstPublish } from '../../_tests_/support/project-transaction.js';
import { publishPreparedTransaction } from '../../project/transaction/transactional-writer.js';
import { readCloudLink, serializeCloudLink, writeCloudLink, type CloudLink } from '../link.js';
import { createCloudBundle, planPullChanges, pushCloudProject, pullCloudProject } from '../sync.js';

const directories: string[] = [];

const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');

const createDirectory = async () => {
  const root = await mkdtemp(join(tmpdir(), 'attest-cloud-sync-'));
  directories.push(root);
  await mkdir(join(root, 'attest'));

  return root;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('cloud pull conflict planning', () => {
  it('rejects local edits, deletions and newly occupied remote paths without writing', async () => {
    const root = await createDirectory();
    await writeFile(join(root, 'attest/edited.json'), 'local edit');
    await writeFile(join(root, 'attest/new.json'), 'untracked local');
    await expect(
      Effect.runPromiseExit(
        planPullChanges(
          root,
          {
            'attest/edited.json': hash('base'),
            'attest/deleted.json': hash('base'),
          },
          {
            'attest/edited.json': 'remote',
            'attest/deleted.json': 'remote',
            'attest/new.json': 'remote',
          },
        ),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'project_changed',
      details: { conflicts: ['attest/edited.json', 'attest/deleted.json', 'attest/new.json'] },
    });
    expect(await readFile(join(root, 'attest/edited.json'), 'utf8')).toBe('local edit');
  });
  it('plans removals and updates from the synchronized base with the manifest last', async () => {
    const root = await createDirectory();
    await writeFile(join(root, 'attest/old.json'), 'old');
    await writeFile(join(root, 'attest.project.json'), 'manifest');

    const changes = await Effect.runPromiseExit(
      planPullChanges(
        root,
        {
          'attest/old.json': hash('old'),
          'attest.project.json': hash('manifest'),
        },
        { 'attest.project.json': 'new manifest', 'attest/new.json': 'new' },
      ),
    ).then(valueFromExit);

    expect(changes).toEqual([
      { path: 'attest/new.json', type: 'write', contents: 'new' },
      { path: 'attest/old.json', type: 'remove' },
      { path: 'attest.project.json', type: 'write', contents: 'new manifest' },
    ]);
  });
  it('allows already identical remote files but rejects symlinks and paths outside authored resources', async () => {
    const root = await createDirectory();
    await writeFile(join(root, 'attest/same.json'), 'same');
    expect(
      await Effect.runPromiseExit(planPullChanges(root, {}, { 'attest/same.json': 'same' })).then(
        valueFromExit,
      ),
    ).toEqual([]);
    await symlink(join(root, 'attest/same.json'), join(root, 'attest/link.json'));
    await expect(
      Effect.runPromiseExit(planPullChanges(root, {}, { 'attest/link.json': 'remote' })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({ code: 'project_invalid' });
    await expect(
      Effect.runPromiseExit(planPullChanges(root, {}, { '.env': 'remote' })).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'project_invalid',
    });
  });
});

describe('cloud link state', () => {
  it('round-trips origin-bound revision hashes and rejects malformed state', async () => {
    const root = await createDirectory();

    const link: CloudLink = {
      schema: 'attest.cloud-link.v1',
      base_url: 'https://cloud.example',
      project_id: 'project-1',
      revision_id: 'revision-1',
      file_hashes: { 'attest/test.json': hash('test') },
    };

    await Effect.runPromiseExit(writeCloudLink(root, link)).then(valueFromExit);
    expect(await Effect.runPromiseExit(readCloudLink(root)).then(valueFromExit)).toEqual(link);
    await writeFile(join(root, '.attest/cloud.json'), '{}');
    await expect(
      Effect.runPromiseExit(readCloudLink(root)).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'project_invalid' });
  });
  it('refuses cloud state beneath a symlink', async () => {
    const root = await createDirectory();
    const outside = await createDirectory();
    await symlink(outside, join(root, '.attest'));
    await expect(
      Effect.runPromiseExit(readCloudLink(root)).then(valueFromExit),
    ).rejects.toMatchObject({ code: 'project_invalid' });
  });
});

describe('cloud revision synchronization', () => {
  it('rejects a missing metric entrypoint as a typed validation failure before dispatch', async () => {
    const root = await createDirectory();

    const metric = {
      schema: 'attest.metric',
      id: 'custom',
      name: 'Custom',
      definition: { kind: 'exec', argv: ['./score'] },
    };

    await mkdir(join(root, 'attest/metrics'));
    await writeFile(join(root, 'attest/metrics/custom.json'), JSON.stringify(metric));
    await writeFile(
      join(root, 'attest.project.json'),
      JSON.stringify({
        schema: PROJECT_SCHEMA_ID,
        project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
        name: 'Local',
        resources: {
          agents: [],
          tests: [],
          datasets: [],
          metrics: [
            {
              id: metric.id,
              schema: metric.schema,
              path: 'attest/metrics/custom.json',
              content_hash: contentHash(metric),
            },
          ],
        },
      }),
    );
    await Effect.runPromiseExit(
      writeCloudLink(root, {
        schema: 'attest.cloud-link.v1',
        base_url: 'https://cloud.example',
        project_id: 'project-1',
        file_hashes: {},
      }),
    ).then(valueFromExit);
    let dispatches = 0;

    const client = createCloudClient({
      baseUrl: 'https://cloud.example',
      fetch: () => {
        dispatches++;

        return Promise.reject(new Error('Unexpected dispatch'));
      },
    });

    const exit = await Effect.runPromiseExit(
      pushCloudProject({ workingDirectory: root, client, acknowledgeNoSecrets: true }),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (!Exit.isFailure(exit)) return;
    expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(['Fail']);
    expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(LocalError);
    expect(() => valueFromExit(exit)).toThrow('Metric custom needs a script entrypoint.');
    expect(exit.cause.reasons[0]).toMatchObject({ error: { code: 'project_invalid' } });
    expect(dispatches).toBe(0);
    await expect(readFile(join(root, '.attest/project.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it.each(['push', 'pull'] as const)(
    'keeps %s bundle source mismatches in the typed error channel',
    async (direction) => {
      const root = await createDirectory();

      const manifest = {
        schema: PROJECT_SCHEMA_ID,
        project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
        name: 'Local',
        resources: { agents: [], tests: [], datasets: [], metrics: [] },
      };

      await writeFile(join(root, 'attest.project.json'), JSON.stringify(manifest));

      const project = await Effect.runPromiseExit(loadProject({ project: root })).then(
        valueFromExit,
      );

      const mismatched = JSON.stringify({ ...manifest, name: 'Different' });

      await Effect.runPromiseExit(
        writeCloudLink(root, {
          schema: 'attest.cloud-link.v1',
          base_url: 'https://cloud.example',
          project_id: 'project-1',
          file_hashes: {},
        }),
      ).then(valueFromExit);

      const client = createCloudClient({
        baseUrl: 'https://cloud.example',
        fetch: () =>
          Promise.resolve(
            Response.json({
              revision: { id: 'revision-1', project_id: 'project-1', created_at: '2026-10-01' },
              bundle: {
                schema: 'attest.project-bundle.v1',
                resources: { project: manifest, agents: [], tests: [], datasets: [], metrics: [] },
                files: { 'attest.project.json': mismatched },
              },
            }),
          ),
      });

      if (direction === 'push') await writeFile(join(root, 'attest.project.json'), mismatched);
      const before = await readFile(join(root, 'attest.project.json'), 'utf8');

      const exit =
        direction === 'push'
          ? await Effect.runPromiseExit(createCloudBundle(project).pipe(Effect.asVoid))
          : await Effect.runPromiseExit(
              pullCloudProject({ workingDirectory: root, client }).pipe(Effect.asVoid),
            );

      expect(Exit.isFailure(exit)).toBe(true);

      if (!Exit.isFailure(exit)) return;
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(['Fail']);
      expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
        EvalResolutionError,
      );
      expect(exit.cause.reasons[0]).toMatchObject({
        error: {
          code: 'project_invalid',
          message: 'Bundle resource or hash differs from attest.project.json.',
        },
      });
      expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe(before);
    },
  );
  it('preserves the rejected portable credential field path in upload diagnostics', async () => {
    const root = await createDirectory();
    await mkdir(join(root, 'attest/agents'));

    const agent = {
      schema: AGENT_RESOURCE_SCHEMA_ID,
      id: 'support',
      name: 'Support',
      transport: {
        kind: 'native_cli',
        lifecycle: 'per_case',
        argv: ['node', 'agent.mjs'],
        env: { TOKEN: { from_file: 'token.txt' } },
      },
    };

    await writeFile(
      join(root, 'attest.project.json'),
      JSON.stringify({
        schema: PROJECT_SCHEMA_ID,
        project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
        name: 'Local',
        resources: {
          agents: [
            {
              id: agent.id,
              schema: agent.schema,
              path: 'attest/agents/support.json',
              content_hash: contentHash(agent),
            },
          ],
          tests: [],
          datasets: [],
          metrics: [],
        },
      }),
    );
    await writeFile(join(root, 'attest/agents/support.json'), JSON.stringify(agent));
    await Effect.runPromiseExit(
      writeCloudLink(root, {
        schema: 'attest.cloud-link.v1',
        base_url: 'https://cloud.example',
        project_id: 'project-1',
        file_hashes: {},
      }),
    ).then(valueFromExit);

    const client = createCloudClient({
      baseUrl: 'https://cloud.example',
      fetch: () => Promise.reject(new Error('Must reject before upload.')),
    });

    await expect(
      Effect.runPromiseExit(
        pushCloudProject({ workingDirectory: root, client, acknowledgeNoSecrets: true }),
      ).then(valueFromExit),
    ).rejects.toMatchObject({
      code: 'project_invalid',
      details: {
        diagnostics: [
          {
            path: '/resources/agents/0/transport/env/TOKEN',
            message: 'portable secrets must use environment references',
          },
        ],
      },
    });
  });
  it('uploads only referenced files and pulls exact bytes through the project journal', async () => {
    const root = await createDirectory();

    const manifest = {
      schema: PROJECT_SCHEMA_ID,
      project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAB',
      name: 'Original',
      resources: { agents: [], tests: [], datasets: [], metrics: [] },
    };

    await writeFile(join(root, 'attest.project.json'), JSON.stringify(manifest));
    await writeFile(join(root, '.env'), 'SECRET=never-upload');
    await writeFile(join(root, 'attest/unreferenced.json'), 'private-data');
    await Effect.runPromiseExit(
      writeCloudLink(root, {
        schema: 'attest.cloud-link.v1',
        base_url: 'https://cloud.example',
        project_id: 'project-1',
        file_hashes: {},
      }),
    ).then(valueFromExit);
    let uploaded: PortableProjectBundle | undefined;

    const client = createCloudClient({
      baseUrl: 'https://cloud.example',
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          const body = parseWithSchemaSync(
            stripStruct({
              bundle: portableProjectBundleSchema,
              parent_revision_id: Schema.NullOr(Schema.String),
            }),
            await new Response(init.body).json(),
          );

          expect(body.parent_revision_id).toBe(uploaded === undefined ? null : 'revision-1');
          uploaded = body.bundle;

          return Promise.resolve(
            Response.json({
              revision: { id: 'revision-1', project_id: 'project-1', created_at: '2026-10-01' },
            }),
          );
        }

        let remote = structuredClone(uploaded!);
        remote = {
          ...remote,
          resources: {
            ...remote.resources,
            project: { ...remote.resources.project, name: 'Remote' },
          },
        };
        remote = {
          ...remote,
          files: {
            ...remote.files,
            ['attest.project.json']: JSON.stringify(remote.resources.project, null, 2),
          },
        };

        return Promise.resolve(
          Response.json({
            revision: { id: 'revision-2', project_id: 'project-1', created_at: '2026-10-02' },
            bundle: remote,
          }),
        );
      },
    });

    await expect(
      Effect.runPromiseExit(pushCloudProject({ workingDirectory: root, client })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'cli_usage',
    });
    await Effect.runPromiseExit(
      pushCloudProject({ workingDirectory: root, client, acknowledgeNoSecrets: true }),
    ).then(valueFromExit);
    expect(Object.keys(uploaded!.files)).toEqual(['attest.project.json']);
    await Effect.runPromiseExit(pushCloudProject({ workingDirectory: root, client })).then(
      valueFromExit,
    );
    await Effect.runPromiseExit(pullCloudProject({ workingDirectory: root, client })).then(
      valueFromExit,
    );
    expect(JSON.parse(await readFile(join(root, 'attest.project.json'), 'utf8'))).toMatchObject({
      name: 'Remote',
    });
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('SECRET=never-upload');
    expect(
      (await Effect.runPromiseExit(readCloudLink(root)).then(valueFromExit))?.revision_id,
    ).toBe('revision-2');
    await writeFile(join(root, 'attest.project.json'), 'local unsaved edit');
    await expect(
      Effect.runPromiseExit(pullCloudProject({ workingDirectory: root, client })).then(
        valueFromExit,
      ),
    ).rejects.toMatchObject({
      code: 'project_changed',
    });
    expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe('local unsaved edit');
  });
});

describe('cloud pull crash recovery', () => {
  it.each(['prepared', 'partial', 'published'] as const)(
    'restores code-only revisions interrupted at %s with unchanged manifest bytes',
    async (phase) => {
      const root = await createDirectory();
      await writeFile(join(root, 'attest.project.json'), 'unchanged manifest');
      await writeFile(join(root, 'attest/code.ts'), 'old code');

      const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
        valueFromExit(exit),
      );

      try {
        const transaction = await Effect.runPromiseExit(
          prepareTransaction(root, [
            { path: 'attest/code.ts', type: 'write', contents: 'new code' },
            { path: 'attest.project.json', type: 'write', contents: 'unchanged manifest' },
          ]),
        ).then((exit) => valueFromExit(exit));

        if (phase === 'partial') {
          await interruptAfterFirstPublish(root, transaction);
          expect(await readFile(join(root, 'attest/code.ts'), 'utf8')).toBe('new code');
        } else if (phase === 'published') {
          await Effect.runPromiseExit(publishPreparedTransaction(root, transaction)).then((exit) =>
            valueFromExit(exit),
          );
        }

        expect(
          await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
            valueFromExit(exit),
          ),
        ).toEqual([{ action: 'rolled_back', transactionId: transaction.journal.transaction_id }]);
        expect(await readFile(join(root, 'attest/code.ts'), 'utf8')).toBe('old code');
        expect(await readFile(join(root, 'attest.project.json'), 'utf8')).toBe(
          'unchanged manifest',
        );
      } finally {
        await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
      }
    },
  );
});

it.each(['changed', 'unchanged'])(
  'recovers the cloud link after authored commit with %s manifest bytes',
  async (kind) => {
    const root = await createDirectory();
    const manifest = kind === 'changed' ? 'new manifest' : 'old manifest';
    await writeFile(join(root, 'attest.project.json'), 'old manifest');
    await writeFile(join(root, 'attest/code.ts'), 'old code');

    const before: CloudLink = {
      schema: 'attest.cloud-link.v1',
      base_url: 'https://cloud.example',
      project_id: 'project-1',
      revision_id: 'revision-1',
      file_hashes: {
        'attest.project.json': hash('old manifest'),
        'attest/code.ts': hash('old code'),
      },
    };

    const after: CloudLink = {
      ...before,
      revision_id: 'revision-2',
      file_hashes: { 'attest.project.json': hash(manifest), 'attest/code.ts': hash('new code') },
    };

    await Effect.runPromiseExit(writeCloudLink(root, before)).then(valueFromExit);

    const lock = await Effect.runPromiseExit(acquireProjectLock(root)).then((exit) =>
      valueFromExit(exit),
    );

    try {
      let transaction = await Effect.runPromiseExit(
        prepareTransaction(
          root,
          [
            { type: 'write', path: 'attest/code.ts', contents: 'new code' },
            { type: 'write', path: 'attest.project.json', contents: manifest },
          ],
          {
            completion: { path: '.attest/cloud.json', contents: serializeCloudLink(after) },
          },
        ),
      ).then((exit) => valueFromExit(exit));

      await Effect.runPromiseExit(publishPreparedTransaction(root, transaction)).then((exit) =>
        valueFromExit(exit),
      );
      transaction = { ...transaction, journal: { ...transaction.journal, status: 'committed' } };
      await Effect.runPromiseExit(writeTransactionJournal(transaction)).then((exit) =>
        valueFromExit(exit),
      );
      expect(await Effect.runPromiseExit(readCloudLink(root)).then(valueFromExit)).toEqual(before);
      expect(
        await Effect.runPromiseExit(recoverProjectTransactions(root, lock)).then((exit) =>
          valueFromExit(exit),
        ),
      ).toEqual([
        { action: 'completed_commit', transactionId: transaction.journal.transaction_id },
      ]);
      expect(await Effect.runPromiseExit(readCloudLink(root)).then(valueFromExit)).toEqual(after);
      expect(await readFile(join(root, 'attest/code.ts'), 'utf8')).toBe('new code');
      expect(
        await Effect.runPromiseExit(
          planPullChanges(root, after.file_hashes, {
            'attest.project.json': manifest,
            'attest/code.ts': 'third revision',
          }),
        ).then(valueFromExit),
      ).toContainEqual({ type: 'write', path: 'attest/code.ts', contents: 'third revision' });
    } finally {
      await Effect.runPromiseExit(releaseProjectLock(lock)).then((exit) => valueFromExit(exit));
    }
  },
);
