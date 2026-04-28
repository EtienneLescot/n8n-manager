import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from './index.js';

async function captureStdout(callback: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const originalWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await callback();
    return { code, stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function withManagerHome<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.N8N_MANAGER_HOME;
  process.env.N8N_MANAGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-manager-cli-'));
  return callback().finally(() => {
    if (previous === undefined) {
      delete process.env.N8N_MANAGER_HOME;
    } else {
      process.env.N8N_MANAGER_HOME = previous;
    }
  });
}

test('CLI manages global instances and sync folder', async () => {
  await withManagerHome(async () => {
    const added = await captureStdout(() => runCli([
      'instances',
      'add',
      '--id',
      'prod',
      '--name',
      'Production',
      '--mode',
      'existing',
      '--url',
      'https://prod.example.test',
      '--api-key',
      'prod-key',
    ]));
    assert.equal(added.code, 0);
    assert.equal(JSON.parse(added.stdout).instance.id, 'prod');

    const sync = await captureStdout(() => runCli(['config', 'set-sync-folder', '/tmp/n8n-workflows']));
    assert.equal(sync.code, 0);
    assert.equal(JSON.parse(sync.stdout).defaultSyncFolder, '/tmp/n8n-workflows');

    const listed = await captureStdout(() => runCli(['instances', 'list']));
    const config = JSON.parse(listed.stdout);
    assert.equal(config.activeInstanceId, 'prod');
    assert.equal(config.instances[0].name, 'Production');
  });
});
