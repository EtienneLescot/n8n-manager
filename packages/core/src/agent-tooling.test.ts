import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  N8nConfigurationService,
  buildManagedN8nSameOriginWorkflowOpenPage,
  buildManagedN8nWorkflowOpenPage,
  getN8nManagerAgentInstructions,
  presentWorkflowResult,
  resolveWorkflowWebviewOpen,
} from './index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-manager-agent-tooling-'));
}

test('agent instructions describe n8n-manager shell tools', () => {
  const instructions = getN8nManagerAgentInstructions({ command: 'node ./n8n-manager.js' });

  assert.match(instructions, /presentWorkflowResult --workflow-id/);
  assert.match(instructions, /llm-proxy status/);
  assert.match(instructions, /Do not loop/);
  assert.match(instructions, /node \.\/n8n-manager\.js/);
});

test('presentWorkflowResult returns a workflow embed payload from global config', async () => {
  const service = new N8nConfigurationService({ baseDir: tempDir() });
  service.upsertInstance({
    id: 'local',
    name: 'Local',
    mode: 'existing',
    baseUrl: 'http://127.0.0.1:5678',
  });

  const result = await presentWorkflowResult({ workflowId: 'wf-123', title: 'Demo' }, service);

  assert.equal(result.__type, 'workflow-embed');
  assert.equal(result.kind, 'workflow');
  assert.equal(result.workflowId, 'wf-123');
  assert.equal(result.title, 'Demo');
  assert.equal(result.workflowUrl, 'http://127.0.0.1:5678/workflow/wf-123');
  assert.equal(result.url, 'http://127.0.0.1:5678/workflow/wf-123');
  assert.equal(result.via, 'direct');
});

test('managed workflow open page posts owner credentials to n8n login', () => {
  const html = buildManagedN8nWorkflowOpenPage({
    targetUrl: 'http://127.0.0.1:5678/workflow/wf-123',
    loginUrl: 'http://127.0.0.1:5678/rest/login',
    credentials: {
      email: 'owner@example.test',
      password: 'SecretPassword1',
    },
  });

  assert.match(html, /Opening n8n workflow/);
  assert.match(html, /emailOrLdapLoginId/);
  assert.match(html, /owner@example\.test/);
  assert.match(html, /SecretPassword1/);
  assert.match(html, /http:\/\/127\.0\.0\.1:5678\/workflow\/wf-123/);
});

test('workflow webview open payload returns same-origin auto-login page for managed local instances', async () => {
  const baseDir = tempDir();
  const runtimeStatePath = path.join(baseDir, 'runtime.json');
  fs.writeFileSync(runtimeStatePath, JSON.stringify({
    ownerEmail: 'owner@example.test',
    ownerPassword: 'SecretPassword1',
  }));
  const service = new N8nConfigurationService({ baseDir });
  service.upsertInstance({
    id: 'local',
    name: 'Local',
    mode: 'managed-local-docker',
    baseUrl: 'http://127.0.0.1:5678',
    runtimeStatePath,
  });

  const result = await resolveWorkflowWebviewOpen({
    workflowId: 'wf-123',
    proxyBaseUrl: 'http://localhost:14567',
  }, service);

  assert.equal(result.via, 'self-contained-auth');
  assert.equal(result.targetUrl, 'http://localhost:14567/workflow/wf-123');
  assert.equal(result.url, 'http://localhost:14567/__n8n-manager/open-workflow/wf-123');
  assert.match(result.autoLoginPageHtml ?? '', /fetch\(loginUrl/);
  assert.match(result.autoLoginPageHtml ?? '', /owner@example\.test/);
});

test('same-origin workflow open page logs in then redirects without opening a popup', () => {
  const html = buildManagedN8nSameOriginWorkflowOpenPage({
    targetUrl: 'http://localhost:14567/workflow/wf-123',
    loginUrl: 'http://localhost:14567/rest/login',
    credentials: {
      email: 'owner@example.test',
      password: 'SecretPassword1',
    },
  });

  assert.match(html, /fetch\(loginUrl/);
  assert.match(html, /window\.location\.replace\(targetUrl\)/);
  assert.doesNotMatch(html, /window\.open/);
});
