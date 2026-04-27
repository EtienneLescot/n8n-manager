import type { CredentialTestResult, N8nCredentialClient, N8nCredentialRef } from './types.js';

export interface N8nRestCredentialClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface N8nCredentialRecord {
  id?: string;
  name?: string;
  type?: string;
}

export class N8nRestCredentialClient implements N8nCredentialClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: N8nRestCredentialClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listCredentials(): Promise<N8nCredentialRef[]> {
    const results: N8nCredentialRef[] = [];
    let cursor: string | undefined;

    do {
      const path = cursor ? `/api/v1/credentials?cursor=${encodeURIComponent(cursor)}` : '/api/v1/credentials';
      const page = await this.request<{ data?: N8nCredentialRecord[]; nextCursor?: string }>('GET', path);
      for (const credential of page.data ?? []) {
        if (!credential.id || !credential.name || !credential.type) continue;
        results.push({
          id: credential.id,
          name: credential.name,
          type: credential.type,
          recipeId: '',
          service: '',
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return results;
  }

  async getCredentialSchema(typeName: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/api/v1/credentials/schema/${encodeURIComponent(typeName)}`);
  }

  async upsertCredential(input: {
    id?: string;
    name: string;
    type: string;
    data: Record<string, unknown>;
    recipeId: string;
    service: string;
    projectId?: string;
  }): Promise<N8nCredentialRef> {
    const existing = input.id
      ? { id: input.id }
      : await this.findExistingCredential(input.name, input.type);
    const payload = {
      name: input.name,
      type: input.type,
      data: input.data,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };

    const result = existing
      ? await this.request<N8nCredentialRecord>('PATCH', `/api/v1/credentials/${encodeURIComponent(existing.id)}`, payload)
      : await this.request<N8nCredentialRecord>('POST', '/api/v1/credentials', payload);

    return {
      id: String(result.id ?? existing?.id ?? ''),
      name: String(result.name ?? input.name),
      type: String(result.type ?? input.type),
      recipeId: input.recipeId,
      service: input.service,
    };
  }

  private async findExistingCredential(name: string, type: string): Promise<N8nCredentialRef | undefined> {
    try {
      return (await this.listCredentials()).find((credential) =>
        credential.name === name && credential.type === type,
      );
    } catch {
      return undefined;
    }
  }

  async testCredential(credentialId: string): Promise<CredentialTestResult> {
    try {
      await this.request<N8nCredentialRecord>('GET', `/api/v1/credentials/${encodeURIComponent(credentialId)}`);
      return {
        credentialId,
        status: 'pass',
        message: 'n8n API returned credential metadata. Secret-level service validation is recipe-specific.',
      };
    } catch (error) {
      return {
        credentialId,
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteCredential(credentialId: string): Promise<void> {
    await this.request<Record<string, unknown>>('DELETE', `/api/v1/credentials/${encodeURIComponent(credentialId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-N8N-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) as unknown : {};

    if (!response.ok) {
      throw new Error(`n8n API ${method} ${path} failed with ${response.status}: ${formatErrorPayload(data)}`);
    }

    return data as T;
  }
}

function formatErrorPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return String(payload ?? '');
  }
  const record = payload as Record<string, unknown>;
  return String(record.message ?? record.error ?? JSON.stringify(record)).slice(0, 500);
}
