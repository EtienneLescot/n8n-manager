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
    const help = await captureStdout(() => runCli(['instances', '--help']));
    assert.equal(help.code, 0);
    assert.match(help.stdout, /instances add --name NAME --mode managed-local-docker/);
    assert.match(help.stdout, /There is no "instances create" command/);

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

    const status = await captureStdout(() => runCli(['instances', 'status', 'Production']));
    assert.equal(status.code, 0);
    const runtime = JSON.parse(status.stdout);
    assert.equal(runtime.instanceId, 'prod');
    assert.equal(runtime.ready, true);

    const topLevelStatus = await captureStdout(() => runCli(['status', '--instance', 'prod']));
    assert.equal(topLevelStatus.code, 0);
    assert.equal(JSON.parse(topLevelStatus.stdout).instanceId, 'prod');
  });
});

test('CLI manages auth and default projects through n8n-manager', async () => {
  await withManagerHome(async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = input.toString();
      if (url.endsWith('/api/v1/workflows')) {
        return Response.json({ data: [] });
      }
      if (url.endsWith('/api/v1/projects')) {
        return Response.json({
          data: [
            { id: 'personal', name: 'Personal', type: 'personal' },
            { id: 'project-main', name: 'Main', type: 'team' },
          ],
        });
      }
      return new Response('{}', { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;
    try {
      const saved = await captureStdout(() => runCli([
        'auth',
        'set',
        '--id',
        'local',
        '--name',
        'Local',
        '--url',
        'http://127.0.0.1:5678',
        '--api-key',
        'local-key',
      ]));
      assert.equal(saved.code, 0);
      assert.equal(JSON.parse(saved.stdout).instance.id, 'local');

      const listed = await captureStdout(() => runCli(['projects', 'list', '--instance', 'local']));
      assert.equal(listed.code, 0);
      assert.equal(JSON.parse(listed.stdout).projects[1].id, 'project-main');

      const selected = await captureStdout(() => runCli(['projects', 'select', 'Main', '--instance', 'local']));
      assert.equal(selected.code, 0);
      assert.equal(JSON.parse(selected.stdout).project.id, 'project-main');
    } finally {
      globalThis.fetch = previousFetch;
    }
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

    const instructions = await captureStdout(() => runCli([
      'agent',
      'instructions',
      '--command',
      'node ./n8n-manager.js',
      '--workspace-root',
      '/tmp/n8n-workspace',
    ]));
    assert.equal(instructions.code, 0);
    assert.match(instructions.stdout, /presentWorkflowResult --workflow-id <workflowId> --workspace-root '\/tmp\/n8n-workspace'/);
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

    const global = await captureStdout(() => runCli([
      'instances',
      'add',
      '--id',
      'global',
      '--name',
      'Global',
      '--mode',
      'existing',
      '--url',
      'http://global.example.test',
    ]));
    assert.equal(global.code, 0);

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-manager-cli-workspace-'));
    fs.writeFileSync(path.join(workspaceRoot, 'n8nac-config.json'), JSON.stringify({
      version: 3,
      activeInstanceId: 'local',
    }));
    const previousCwd = process.cwd();
    process.chdir(workspaceRoot);
    try {
      const workspacePresented = await captureStdout(() => runCli([
        'presentWorkflowResult',
        '--workflow-id',
        'wf-workspace',
      ]));
      assert.equal(workspacePresented.code, 0);
      assert.equal(JSON.parse(workspacePresented.stdout).url, 'http://127.0.0.1:5678/workflow/wf-workspace');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }

    const bridge = await captureStdout(() => runCli(['auth-bridge', 'status']));
    assert.equal(bridge.code, 0);
    assert.equal(JSON.parse(bridge.stdout).operation, 'auth-bridge.status');
  });
});
