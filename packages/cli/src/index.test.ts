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

test('CLI exposes agent instructions and workflow presentation payloads', async () => {
  await withManagerHome(async () => {
    const added = await captureStdout(() => runCli([
      'instances',
      'add',
      '--id',
      'local',
      '--name',
      'Local',
      '--mode',
      'existing',
      '--url',
      'http://127.0.0.1:5678',
    ]));
    assert.equal(added.code, 0);

    const instructions = await captureStdout(() => runCli(['agent', 'instructions', '--command', 'node ./n8n-manager.js']));
    assert.equal(instructions.code, 0);
    assert.match(instructions.stdout, /presentWorkflowResult --workflow-id/);
    assert.match(instructions.stdout, /node \.\/n8n-manager\.js llm-proxy status/);

    const presented = await captureStdout(() => runCli([
      'presentWorkflowResult',
      '--workflow-id',
      'wf-123',
      '--title',
      'Demo',
      '--instance',
      'Local',
    ]));
    assert.equal(presented.code, 0);
    const payload = JSON.parse(presented.stdout);
    assert.equal(payload.__type, 'workflow-embed');
    assert.equal(payload.workflowId, 'wf-123');
    assert.equal(payload.url, 'http://127.0.0.1:5678/workflow/wf-123');

    const bridge = await captureStdout(() => runCli(['auth-bridge', 'status']));
    assert.equal(bridge.code, 0);
    assert.equal(JSON.parse(bridge.stdout).operation, 'auth-bridge.status');
  });
});
