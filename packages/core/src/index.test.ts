import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileBackedN8nLifecycleManager, readFileBackedN8nInstance, type FileBackedN8nLifecycleManagerOptions } from './index.js';

type DockerState = {
  exists?: boolean;
  running?: boolean;
  commands: string[];
};

function createDockerRunner(state: DockerState): FileBackedN8nLifecycleManagerOptions['runner'] {
  return async (command, args) => {
    state.commands.push([command, ...args].join(' '));

    if (command !== 'docker') {
      throw new Error(`Unexpected command: ${command}`);
    }

    if (args[0] === 'version') {
      return { stdout: '25.0.0\n', stderr: '' };
    }

    if (args[0] === 'inspect') {
      if (!state.exists) {
        throw new Error('No such container');
      }
      return { stdout: `${state.running ? 'true' : 'false'}\n`, stderr: '' };
    }

    if (args[0] === 'volume' && args[1] === 'create') {
      return { stdout: `${args[2]}\n`, stderr: '' };
    }

    if (args[0] === 'volume' && args[1] === 'rm') {
      return { stdout: `${args[2]}\n`, stderr: '' };
    }

    if (args[0] === 'run') {
      state.exists = true;
      state.running = true;
      return { stdout: 'container-id\n', stderr: '' };
    }

    if (args[0] === 'start') {
      state.exists = true;
      state.running = true;
      return { stdout: args[1] + '\n', stderr: '' };
    }

    if (args[0] === 'stop') {
      state.running = false;
      return { stdout: args[1] + '\n', stderr: '' };
    }

    if (args[0] === 'restart') {
      state.exists = true;
      state.running = true;
      return { stdout: args[1] + '\n', stderr: '' };
    }

    if (args[0] === 'rm') {
      state.exists = false;
      state.running = false;
      return { stdout: args.at(-1) + '\n', stderr: '' };
    }

    throw new Error(`Unexpected docker args: ${args.join(' ')}`);
  };
}

test('file-backed lifecycle setup can be deleted without destroying data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const manager = new FileBackedN8nLifecycleManager(statePath);

  await manager.setup({ mode: 'existing', baseUrl: 'http://127.0.0.1:5678' });
  assert.equal((await manager.status()).status, 'ready');

  const deleted = await manager.delete();
  assert.equal(deleted.status, 'not-configured');
  assert.equal((await manager.status()).status, 'not-configured');
});

test('file-backed lifecycle refuses data destruction without force', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const dockerState: DockerState = { commands: [] };
  const manager = new FileBackedN8nLifecycleManager(statePath, {
    runner: createDockerRunner(dockerState),
    bootstrapOwner: false,
    waitForReady: false,
  });

  await manager.setup({ mode: 'managed-local-docker' });
  await assert.rejects(
    () => manager.delete({ destroyData: true }),
    /without force=true/,
  );
});

test('managed-local-docker setup creates and reports a real docker container', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const dockerState: DockerState = { commands: [] };
  const manager = new FileBackedN8nLifecycleManager(statePath, {
    runner: createDockerRunner(dockerState),
    containerName: 'test-n8n',
    volumeName: 'test-n8n-data',
    port: 5688,
    bootstrapOwner: false,
    waitForReady: false,
  });

  const instance = await manager.setup({ mode: 'managed-local-docker' });

  assert.equal(instance.provider, 'docker');
  assert.equal(instance.containerName, 'test-n8n');
  assert.equal(instance.volumeName, 'test-n8n-data');
  assert.equal(instance.baseUrl, 'http://127.0.0.1:5688');
  assert.ok(dockerState.commands.some((command) => command.startsWith('docker run -d --name test-n8n')));

  const status = await manager.status();
  assert.equal(status.status, 'ready');
  assert.equal(status.checks[0].status, 'pass');
});

test('managed-local-docker delete removes the container and can destroy the volume with force', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const dockerState: DockerState = { commands: [] };
  const manager = new FileBackedN8nLifecycleManager(statePath, {
    runner: createDockerRunner(dockerState),
    containerName: 'test-n8n-delete',
    volumeName: 'test-n8n-delete-data',
    bootstrapOwner: false,
    waitForReady: false,
  });

  await manager.setup({ mode: 'managed-local-docker' });
  const deleted = await manager.delete({ destroyData: true, force: true });

  assert.equal(deleted.status, 'not-configured');
  assert.ok(dockerState.commands.includes('docker rm -f test-n8n-delete'));
  assert.ok(dockerState.commands.includes('docker volume rm test-n8n-delete-data'));
  assert.equal((await manager.status()).status, 'not-configured');
});

test('managed-local-docker bootstrap logs in when owner setup already exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const dockerState: DockerState = { commands: [] };
  const requests: string[] = [];
  const apiKeyBodies: Array<{ scopes?: string[] }> = [];
  const manager = new FileBackedN8nLifecycleManager(statePath, {
    runner: createDockerRunner(dockerState),
    containerName: 'test-n8n-bootstrap',
    volumeName: 'test-n8n-bootstrap-data',
    waitForReady: false,
    fetch: (async (input, init) => {
      const url = input.toString();
      requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);

      if (url.endsWith('/rest/owner/setup')) {
        return new Response(JSON.stringify({ message: 'Owner already setup' }), {
          status: 400,
          statusText: 'Bad Request',
        });
      }
      if (url.endsWith('/rest/login')) {
        return new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'n8n-auth=session-cookie; Path=/; HttpOnly' },
        });
      }
      if (url.endsWith('/rest/api-keys')) {
        apiKeyBodies.push(JSON.parse(String(init?.body ?? '{}')) as { scopes?: string[] });
        return Response.json({ data: { rawApiKey: 'n8n_api_test' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  await fs.writeFile(statePath, JSON.stringify({
    id: 'test-n8n-bootstrap',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5678',
    provider: 'docker',
    containerName: 'test-n8n-bootstrap',
    volumeName: 'test-n8n-bootstrap-data',
    ownerEmail: 'stored-owner@local.invalid',
    ownerPassword: 'StoredOwnerPassword1',
    ownerFirstName: 'Stored',
    ownerLastName: 'Owner',
  }, null, 2));

  const instance = await manager.setup({ mode: 'managed-local-docker' });
  const rawState = await readFileBackedN8nInstance(statePath);

  assert.equal(instance.apiKeyAvailable, true);
  assert.equal(instance.ownerCredentialsAvailable, true);
  assert.equal(instance.apiKey, undefined);
  assert.equal(instance.ownerPassword, undefined);
  assert.equal(rawState?.apiKey, 'n8n_api_test');
  assert.equal(rawState?.ownerPassword, 'StoredOwnerPassword1');
  assert.deepEqual(requests.slice(0, 3), [
    'POST /rest/owner/setup',
    'POST /rest/login',
    'POST /rest/api-keys',
  ]);
  assert.ok(apiKeyBodies[0]?.scopes?.includes('credential:read'));
});

test('managed-local-docker refreshes stored API keys with missing scopes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const dockerState: DockerState = { commands: [] };
  const requests: string[] = [];
  const manager = new FileBackedN8nLifecycleManager(statePath, {
    runner: createDockerRunner(dockerState),
    containerName: 'test-n8n-refresh-key',
    volumeName: 'test-n8n-refresh-key-data',
    waitForReady: false,
    fetch: (async (input, init) => {
      const url = input.toString();
      requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);

      if (url.endsWith('/rest/owner/setup')) {
        return new Response(JSON.stringify({ message: 'Owner already setup' }), {
          status: 400,
          statusText: 'Bad Request',
        });
      }
      if (url.endsWith('/rest/login')) {
        return new Response('{}', {
          status: 200,
          headers: { 'set-cookie': 'n8n-auth=session-cookie; Path=/; HttpOnly' },
        });
      }
      if (url.endsWith('/rest/api-keys')) {
        return Response.json({ data: { rawApiKey: 'n8n_api_refreshed' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  await fs.writeFile(statePath, JSON.stringify({
    id: 'test-n8n-refresh-key',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5678',
    provider: 'docker',
    containerName: 'test-n8n-refresh-key',
    volumeName: 'test-n8n-refresh-key-data',
    apiKey: 'n8n_api_old',
    apiKeyScopes: ['workflow:read'],
    ownerEmail: 'stored-owner@local.invalid',
    ownerPassword: 'StoredOwnerPassword1',
    ownerFirstName: 'Stored',
    ownerLastName: 'Owner',
  }, null, 2));

  await manager.setup({ mode: 'managed-local-docker' });
  const rawState = await readFileBackedN8nInstance(statePath);

  assert.equal(rawState?.apiKey, 'n8n_api_refreshed');
  assert.ok(rawState?.apiKeyScopes?.includes('credential:read'));
  assert.deepEqual(requests.slice(0, 3), [
    'POST /rest/owner/setup',
    'POST /rest/login',
    'POST /rest/api-keys',
  ]);
});
