import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type N8nInstanceMode = 'managed-local-docker' | 'managed-local-direct' | 'existing' | 'generation-only';

export type N8nInstanceStatus = 'unknown' | 'not-configured' | 'starting' | 'ready' | 'unhealthy' | 'stopped';

export interface N8nInstanceRef {
  id: string;
  mode: N8nInstanceMode;
  baseUrl?: string;
  apiKeyRef?: string;
  projectName?: string;
}

export interface N8nHealthSnapshot {
  status: N8nInstanceStatus;
  instance?: N8nInstanceRef;
  checks: Array<{
    id: string;
    label: string;
    status: 'pass' | 'warn' | 'fail' | 'skip';
    message?: string;
  }>;
}

export interface DeleteN8nInstanceInput {
  destroyData?: boolean;
  force?: boolean;
}

export interface N8nLifecycleManager {
  setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string }): Promise<N8nInstanceRef>;
  status(): Promise<N8nHealthSnapshot>;
  start(): Promise<N8nHealthSnapshot>;
  stop(): Promise<N8nHealthSnapshot>;
  restart(): Promise<N8nHealthSnapshot>;
  delete(input?: DeleteN8nInstanceInput): Promise<N8nHealthSnapshot>;
}

export interface N8nWorkflowManager {
  deployWorkflow(filePath: string): Promise<{ workflowId: string; url?: string }>;
  executeWorkflow(workflowId: string, input?: unknown): Promise<{ executionId: string; status: 'running' | 'success' | 'error' }>;
}

export interface N8nManager {
  lifecycle: N8nLifecycleManager;
  workflows?: N8nWorkflowManager;
}

export class NonDestructiveN8nLifecycleManager implements N8nLifecycleManager {
  private instance?: N8nInstanceRef;

  async setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string }): Promise<N8nInstanceRef> {
    this.instance = {
      id: input.baseUrl ?? input.mode,
      mode: input.mode,
      baseUrl: input.baseUrl,
      apiKeyRef: input.apiKeyRef,
    };
    return this.instance;
  }

  async status(): Promise<N8nHealthSnapshot> {
    if (!this.instance) {
      return {
        status: 'not-configured',
        checks: [{ id: 'instance', label: 'n8n instance', status: 'warn', message: 'No instance configured.' }],
      };
    }

    return {
      status: this.instance.mode === 'generation-only' ? 'stopped' : 'ready',
      instance: this.instance,
      checks: [{ id: 'instance', label: 'n8n instance', status: 'pass', message: 'Instance configuration is present.' }],
    };
  }

  async start(): Promise<N8nHealthSnapshot> {
    return this.status();
  }

  async stop(): Promise<N8nHealthSnapshot> {
    const snapshot = await this.status();
    return { ...snapshot, status: 'stopped' };
  }

  async restart(): Promise<N8nHealthSnapshot> {
    return this.status();
  }

  async delete(input: DeleteN8nInstanceInput = {}): Promise<N8nHealthSnapshot> {
    if (input.destroyData && !input.force) {
      throw new Error('Refusing to destroy n8n data without force=true.');
    }
    this.instance = undefined;
    return {
      status: 'not-configured',
      checks: [{ id: 'instance', label: 'n8n instance', status: 'pass', message: 'Instance configuration deleted.' }],
    };
  }
}

export class FileBackedN8nLifecycleManager implements N8nLifecycleManager {
  constructor(private readonly statePath = path.join(os.homedir(), '.n8n-manager', 'instance.json')) {}

  async setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string }): Promise<N8nInstanceRef> {
    const instance: N8nInstanceRef = {
      id: input.baseUrl ?? input.mode,
      mode: input.mode,
      baseUrl: input.baseUrl,
      apiKeyRef: input.apiKeyRef,
    };
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(instance, null, 2));
    return instance;
  }

  async status(): Promise<N8nHealthSnapshot> {
    const instance = await this.readInstance();
    if (!instance) {
      return {
        status: 'not-configured',
        checks: [{ id: 'instance', label: 'n8n instance', status: 'warn', message: 'No instance configured.' }],
      };
    }

    return {
      status: instance.mode === 'generation-only' ? 'stopped' : 'ready',
      instance,
      checks: [{ id: 'instance', label: 'n8n instance', status: 'pass', message: 'Instance configuration is present.' }],
    };
  }

  async start(): Promise<N8nHealthSnapshot> {
    return this.status();
  }

  async stop(): Promise<N8nHealthSnapshot> {
    const snapshot = await this.status();
    return { ...snapshot, status: 'stopped' };
  }

  async restart(): Promise<N8nHealthSnapshot> {
    return this.status();
  }

  async delete(input: DeleteN8nInstanceInput = {}): Promise<N8nHealthSnapshot> {
    if (input.destroyData && !input.force) {
      throw new Error('Refusing to destroy n8n data without force=true.');
    }

    await fs.rm(this.statePath, { force: true });
    return {
      status: 'not-configured',
      checks: [{
        id: 'instance',
        label: 'n8n instance',
        status: 'pass',
        message: input.destroyData
          ? 'Instance configuration deleted. Managed data destruction is acknowledged but no provider-specific volume removal is wired yet.'
          : 'Instance configuration deleted.',
      }],
    };
  }

  private async readInstance(): Promise<N8nInstanceRef | undefined> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(content) as N8nInstanceRef;
      return parsed.id && parsed.mode ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
