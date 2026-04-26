import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileBackedN8nLifecycleManager } from './index.js';

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
  const manager = new FileBackedN8nLifecycleManager(statePath);

  await manager.setup({ mode: 'managed-local-docker' });
  await assert.rejects(
    () => manager.delete({ destroyData: true }),
    /without force=true/,
  );
});
