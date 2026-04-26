import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCredentialStateStore } from './store.js';
import { N8nCredentialsManager } from './manager.js';
import { N8nRestCredentialClient } from './n8n-rest-client.js';

test('lists recipes and exposes the required LLM proxy recipe', async () => {
  const manager = new N8nCredentialsManager({ store: new MemoryCredentialStateStore() });
  const recipes = await manager.listRecipes();
  assert.ok(recipes.some((recipe) => recipe.id === 'llm-proxy' && recipe.credentialTypeName === 'openAiApi'));
  assert.ok(recipes.some((recipe) => recipe.id === 'google-oauth'));
  assert.ok(recipes.some((recipe) => recipe.id === 'telegram-bot'));
});

test('ensures an LLM proxy credential from a generic source', async () => {
  const manager = new N8nCredentialsManager({ store: new MemoryCredentialStateStore() });
  const ref = await manager.ensureCredential('llm-proxy', {
    credentialName: 'YAGR LLM',
    source: {
      id: 'yagr-default-llm',
      label: 'YAGR configured LLM',
      async getDescriptor() {
        return {
          provider: 'openai',
          model: 'gpt-4o',
          openAiCompatible: true,
          proxyBaseUrl: 'http://llm-bridge:8080/v1',
        };
      },
    },
  });

  assert.equal(ref.name, 'YAGR LLM');
  const inventory = await manager.getCredentialInventory();
  const item = inventory.availableCredentials.find((candidate) => candidate.recipeId === 'llm-proxy');
  assert.equal(item?.status, 'ready');
  assert.equal(item?.credentialName, 'YAGR LLM');
});

test('starter kit records actionable missing states for credentials without inputs', async () => {
  const manager = new N8nCredentialsManager({ store: new MemoryCredentialStateStore() });
  const result = await manager.bootstrapStarterKit('productivity');
  assert.equal(result.items.length, 3);
  assert.ok(result.items.some((item) => item.recipeId === 'google-oauth' && item.status === 'requires-oauth'));
  assert.ok(result.items.some((item) => item.recipeId === 'notion-token' && item.status === 'requires-api-key'));
});

test('N8nRestCredentialClient patches an existing credential instead of recreating it', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const method = init?.method ?? 'GET';
    if (method === 'GET' && String(url).endsWith('/api/v1/credentials')) {
      return jsonResponse({ data: [{ id: 'cred-1', name: 'LLM Proxy', type: 'openAiApi' }] });
    }
    if (method === 'PATCH' && String(url).endsWith('/api/v1/credentials/cred-1')) {
      return jsonResponse({ id: 'cred-1', name: 'LLM Proxy', type: 'openAiApi' });
    }
    return jsonResponse({ message: 'unexpected' }, 500);
  };

  const client = new N8nRestCredentialClient({
    baseUrl: 'http://127.0.0.1:5678',
    apiKey: 'key',
    fetchImpl: fetchImpl as typeof fetch,
  });

  const ref = await client.upsertCredential({
    name: 'LLM Proxy',
    type: 'openAiApi',
    data: { url: 'http://llm-bridge:8080/v1', apiKey: 'proxy-local-token' },
    recipeId: 'llm-proxy',
    service: 'llm',
  });

  assert.equal(ref.id, 'cred-1');
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), true);
  assert.equal(calls.some((call) => call.init.method === 'POST'), false);
});

test('N8nRestCredentialClient creates when no matching credential exists', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const method = init?.method ?? 'GET';
    if (method === 'GET' && String(url).endsWith('/api/v1/credentials')) {
      return jsonResponse({ data: [] });
    }
    if (method === 'POST' && String(url).endsWith('/api/v1/credentials')) {
      return jsonResponse({ id: 'cred-2', name: 'LLM Proxy', type: 'openAiApi' });
    }
    return jsonResponse({ message: 'unexpected' }, 500);
  };

  const client = new N8nRestCredentialClient({
    baseUrl: 'http://127.0.0.1:5678',
    apiKey: 'key',
    fetchImpl: fetchImpl as typeof fetch,
  });

  const ref = await client.upsertCredential({
    name: 'LLM Proxy',
    type: 'openAiApi',
    data: { url: 'http://llm-bridge:8080/v1', apiKey: 'proxy-local-token' },
    recipeId: 'llm-proxy',
    service: 'llm',
  });

  assert.equal(ref.id, 'cred-2');
  assert.equal(calls.some((call) => call.init.method === 'POST'), true);
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
