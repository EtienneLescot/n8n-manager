import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileBackedN8nLifecycleManager, type FileBackedN8nLifecycleManagerOptions } from './index.js';

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
