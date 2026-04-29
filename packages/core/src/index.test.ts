import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileBackedN8nLifecycleManager,
  N8nConfigurationService,
  N8nRuntimeOrchestrator,
  createManagedLocalLifecycleManager,
  readFileBackedN8nInstance,
  type FileBackedN8nLifecycleManagerOptions,
} from './index.js';

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

    if (args[0] === 'exec') {
      return { stdout: '', stderr: '' };
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
    instanceId: 'test-managed-instance',
    containerName: 'test-n8n',
    volumeName: 'test-n8n-data',
    port: 5688,
    bootstrapOwner: false,
    waitForReady: false,
  });

  const instance = await manager.setup({ mode: 'managed-local-docker' });

  assert.equal(instance.id, 'test-managed-instance');
  assert.equal(instance.provider, 'docker');
  assert.equal(instance.containerName, 'test-n8n');
  assert.equal(instance.volumeName, 'test-n8n-data');
  assert.equal(instance.baseUrl, 'http://127.0.0.1:5688');
  assert.equal(instance.databaseType, 'sqlite');
  assert.equal(instance.databasePath, '/home/node/.n8n/database.sqlite');
  assert.ok(dockerState.commands.some((command) => command.startsWith('docker run -d --name test-n8n')));
  assert.ok(dockerState.commands.some((command) => command.includes('DB_TYPE=sqlite')));
  assert.ok(dockerState.commands.some((command) => command.includes('test-n8n-data:/home/node/.n8n')));

  const status = await manager.status();
  assert.equal(status.status, 'ready');
  assert.equal(status.checks[0].status, 'pass');
});

test('managed-local lifecycle resolution creates isolated runtime names and ports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const service = new N8nConfigurationService({ baseDir: dir });
  service.upsertInstance({
    id: 'n8n-manager-first',
    name: 'First',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5678',
    runtimeStatePath: path.join(dir, 'runtime', 'n8n-manager-first.json'),
    metadata: {
      containerName: 'n8n-manager-first',
      volumeName: 'n8n-manager-first-data',
    },
  });

  const first = await createManagedLocalLifecycleManager(service, { instanceId: 'n8n-manager-first' });
  const second = await createManagedLocalLifecycleManager(service, { name: 'Second' });

  assert.equal(first.instanceId, 'n8n-manager-first');
  assert.equal(first.containerName, 'n8n-manager-first');
  assert.equal(first.port, 5678);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.match(second.containerName, /^n8n-manager-second-/);
  assert.notEqual(second.statePath, first.statePath);
  assert.notEqual(second.port, 5678);
});

test('runtime orchestrator recreates a missing managed container with the stable volume', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-runtime-'));
  const service = new N8nConfigurationService({ baseDir: dir });
  const statePath = service.getRuntimeStatePath('managed-one');
  const dockerState: DockerState = { exists: false, running: false, commands: [] };
  service.upsertInstance({
    id: 'managed-one',
    name: 'Managed One',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5690',
    runtimeStatePath: statePath,
    apiKey: 'n8n_api_managed',
    metadata: {
      containerName: 'managed-one',
      volumeName: 'managed-one-data',
      databaseType: 'sqlite',
      databasePath: '/home/node/.n8n/database.sqlite',
    },
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    id: 'managed-one',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5690',
    provider: 'docker',
    runtimeStatePath: statePath,
    containerName: 'managed-one',
    volumeName: 'managed-one-data',
    databaseType: 'sqlite',
    databasePath: '/home/node/.n8n/database.sqlite',
    apiKey: 'n8n_api_managed',
    apiKeyScopes: DEFAULT_TEST_API_KEY_SCOPES,
  }, null, 2));

  const runtime = new N8nRuntimeOrchestrator({
    configuration: service,
    runner: createDockerRunner(dockerState),
    waitForReady: false,
  });

  const status = await runtime.startInstance('managed-one');

  assert.equal(status.ready, true);
  assert.ok(dockerState.commands.includes('docker volume create managed-one-data'));
  assert.ok(dockerState.commands.some((command) => command.startsWith('docker run -d --name managed-one')));
  assert.ok(dockerState.commands.some((command) => command.includes('managed-one-data:/home/node/.n8n')));
});

test('runtime orchestrator reports Docker unavailable without retry loops', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-runtime-'));
  const service = new N8nConfigurationService({ baseDir: dir });
  const statePath = service.getRuntimeStatePath('docker-down');
  service.upsertInstance({
    id: 'docker-down',
    name: 'Docker Down',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5691',
    runtimeStatePath: statePath,
    apiKey: 'n8n_api_managed',
    metadata: {
      containerName: 'docker-down',
      volumeName: 'docker-down-data',
    },
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    id: 'docker-down',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5691',
    provider: 'docker',
    runtimeStatePath: statePath,
    containerName: 'docker-down',
    volumeName: 'docker-down-data',
    apiKey: 'n8n_api_managed',
  }, null, 2));

  const runtime = new N8nRuntimeOrchestrator({
    configuration: service,
    runner: async () => {
      throw new Error('Cannot connect to the Docker daemon');
    },
    waitForReady: false,
  });

  const status = await runtime.getRuntimeStatus('docker-down');

  assert.equal(status.ready, false);
  assert.equal(status.blocked?.code, 'docker-unavailable');
  assert.match(status.blocked?.message ?? '', /Docker daemon/i);
});

test('runtime orchestrator reuses a live tunnel process for the same target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-runtime-'));
  const previousHome = process.env.N8N_MANAGER_HOME;
  process.env.N8N_MANAGER_HOME = dir;
  const service = new N8nConfigurationService({ baseDir: dir });
  const statePath = service.getRuntimeStatePath('tunnel-managed');
  const dockerState: DockerState = { exists: true, running: true, commands: [] };
  service.upsertInstance({
    id: 'tunnel-managed',
    name: 'Tunnel Managed',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5692',
    runtimeStatePath: statePath,
    apiKey: 'n8n_api_managed',
    tunnelPublicUrl: 'https://stable.trycloudflare.com',
    tunnelTargetUrl: 'http://127.0.0.1:5692',
    tunnelPid: process.pid,
    metadata: {
      containerName: 'tunnel-managed',
      volumeName: 'tunnel-managed-data',
    },
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    id: 'tunnel-managed',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5692',
    provider: 'docker',
    runtimeStatePath: statePath,
    containerName: 'tunnel-managed',
    volumeName: 'tunnel-managed-data',
    apiKey: 'n8n_api_managed',
    tunnelPublicUrl: 'https://stable.trycloudflare.com',
    tunnelTargetUrl: 'http://127.0.0.1:5692',
    tunnelPid: process.pid,
  }, null, 2));
  await fs.writeFile(path.join(dir, 'local-open-bridge.json'), JSON.stringify({
    port: 3791,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    publicUrl: 'https://auth-bridge.trycloudflare.com',
    tunnelTargetUrl: 'http://127.0.0.1:3791',
    tunnelPid: process.pid,
  }, null, 2));

  try {
    const runtime = new N8nRuntimeOrchestrator({
      configuration: service,
      runner: createDockerRunner(dockerState),
      waitForReady: false,
    });

    const status = await runtime.ensureTunnel('tunnel-managed', { action: 'ensure' });

    assert.equal(status.tunnel?.running, true);
    assert.equal(status.tunnel?.publicUrl, 'https://stable.trycloudflare.com');
    assert.equal(status.authBridgeTunnel?.running, true);
    assert.equal(status.authBridgeTunnel?.publicUrl, 'https://auth-bridge.trycloudflare.com');
    assert.ok(!dockerState.commands.some((command) => command.startsWith('docker rm -f tunnel-managed')));
  } finally {
    if (previousHome === undefined) {
      delete process.env.N8N_MANAGER_HOME;
    } else {
      process.env.N8N_MANAGER_HOME = previousHome;
    }
  }
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
  assert.ok(apiKeyBodies[0]?.scopes?.includes('credential:list'));
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
  assert.ok(rawState?.apiKeyScopes?.includes('credential:list'));
  assert.deepEqual(requests.slice(0, 3), [
    'POST /rest/owner/setup',
    'POST /rest/login',
    'POST /rest/api-keys',
  ]);
});

test('managed-local-docker resets stale owner credentials before recreating API key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-manager-lifecycle-'));
  const statePath = path.join(dir, 'instance.json');
  const dockerState: DockerState = { exists: true, running: true, commands: [] };
  const requests: string[] = [];
  let resetDone = false;
  const dockerRunner = createDockerRunner(dockerState);
  const manager = new FileBackedN8nLifecycleManager(statePath, {
    runner: async (command, args) => {
      const result = await dockerRunner?.(command, args);
      if (args[0] === 'exec' && args.includes('user-management:reset')) {
        resetDone = true;
      }
      return result ?? { stdout: '', stderr: '' };
    },
    containerName: 'test-n8n-stale-owner',
    volumeName: 'test-n8n-stale-owner-data',
    waitForReady: false,
    fetch: (async (input, init) => {
      const url = input.toString();
      requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);

      if (url.endsWith('/api/v1/workflows')) {
        return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
      }
      if (url.endsWith('/rest/owner/setup')) {
        return resetDone
          ? new Response('{}', {
            status: 200,
            headers: { 'set-cookie': 'n8n-auth=reset-session-cookie; Path=/; HttpOnly' },
          })
          : new Response(JSON.stringify({ message: 'Owner already setup' }), {
            status: 400,
            statusText: 'Bad Request',
          });
      }
      if (url.endsWith('/rest/login')) {
        return new Response(JSON.stringify({ message: 'Wrong username or password' }), {
          status: 401,
          statusText: 'Unauthorized',
        });
      }
      if (url.endsWith('/rest/api-keys')) {
        return Response.json({ data: { rawApiKey: 'n8n_api_after_reset' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  await fs.writeFile(statePath, JSON.stringify({
    id: 'test-n8n-stale-owner',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5678',
    provider: 'docker',
    containerName: 'test-n8n-stale-owner',
    volumeName: 'test-n8n-stale-owner-data',
    apiKey: 'n8n_api_stale',
    apiKeyScopes: DEFAULT_TEST_API_KEY_SCOPES,
    ownerEmail: 'stored-owner@local.invalid',
    ownerPassword: 'StoredOwnerPassword1',
    ownerFirstName: 'Stored',
    ownerLastName: 'Owner',
  }, null, 2));

  await manager.setup({ mode: 'managed-local-docker' });
  const rawState = await readFileBackedN8nInstance(statePath);

  assert.equal(rawState?.apiKey, 'n8n_api_after_reset');
  assert.ok(dockerState.commands.includes('docker exec test-n8n-stale-owner n8n user-management:reset'));
  assert.deepEqual(requests.filter((request) => request.includes('/rest/owner/setup')), [
    'POST /rest/owner/setup',
    'POST /rest/owner/setup',
  ]);
});

const DEFAULT_TEST_API_KEY_SCOPES = [
  'user:read',
  'user:list',
  'project:list',
  'workflow:read',
  'workflow:list',
  'workflow:create',
  'workflow:update',
  'workflow:delete',
  'workflow:activate',
  'workflow:deactivate',
  'credential:list',
  'credential:create',
  'credential:update',
  'credential:delete',
  'execution:read',
  'execution:list',
];
