import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export type N8nInstanceMode = 'managed-local-docker' | 'managed-local-direct' | 'existing' | 'generation-only';

export type N8nInstanceStatus = 'unknown' | 'not-configured' | 'starting' | 'ready' | 'unhealthy' | 'stopped';

export interface N8nInstanceRef {
  id: string;
  mode: N8nInstanceMode;
  baseUrl?: string;
  apiKeyRef?: string;
  projectName?: string;
  provider?: 'docker' | 'external' | 'none';
  containerName?: string;
  volumeName?: string;
  image?: string;
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

type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface FileBackedN8nLifecycleManagerOptions {
  runner?: CommandRunner;
  dockerImage?: string;
  containerName?: string;
  volumeName?: string;
  port?: number;
}

const execFileAsync = promisify(execFile);

const DEFAULT_DOCKER_IMAGE = 'n8nio/n8n:latest';
const DEFAULT_CONTAINER_NAME = 'n8n-manager-local';
const DEFAULT_VOLUME_NAME = 'n8n-manager-local-data';
const DEFAULT_PORT = 5678;

async function defaultRunner(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, { encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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
  private readonly runner: CommandRunner;
  private readonly dockerImage: string;
  private readonly containerName: string;
  private readonly volumeName: string;
  private readonly port: number;

  constructor(
    private readonly statePath = path.join(os.homedir(), '.n8n-manager', 'instance.json'),
    options: FileBackedN8nLifecycleManagerOptions = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
    this.dockerImage = options.dockerImage ?? process.env.N8N_MANAGER_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
    this.containerName = options.containerName ?? process.env.N8N_MANAGER_DOCKER_CONTAINER ?? DEFAULT_CONTAINER_NAME;
    this.volumeName = options.volumeName ?? process.env.N8N_MANAGER_DOCKER_VOLUME ?? DEFAULT_VOLUME_NAME;
    this.port = Number(options.port ?? process.env.N8N_MANAGER_DOCKER_PORT ?? DEFAULT_PORT);
  }

  async setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string }): Promise<N8nInstanceRef> {
    if (input.mode === 'managed-local-docker') {
      await this.ensureDockerContainer();
    }

    const instance: N8nInstanceRef = {
      id: input.mode === 'managed-local-docker' ? this.containerName : (input.baseUrl ?? input.mode),
      mode: input.mode,
      baseUrl: input.mode === 'managed-local-docker' ? `http://127.0.0.1:${this.port}` : input.baseUrl,
      apiKeyRef: input.apiKeyRef,
      provider: input.mode === 'managed-local-docker'
        ? 'docker'
        : input.mode === 'existing'
          ? 'external'
          : 'none',
      containerName: input.mode === 'managed-local-docker' ? this.containerName : undefined,
      volumeName: input.mode === 'managed-local-docker' ? this.volumeName : undefined,
      image: input.mode === 'managed-local-docker' ? this.dockerImage : undefined,
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
      status: await this.resolveStatus(instance),
      instance,
      checks: await this.resolveChecks(instance),
    };
  }

  async start(): Promise<N8nHealthSnapshot> {
    const instance = await this.readInstance();
    if (instance?.mode === 'managed-local-docker') {
      await this.runner('docker', ['start', instance.containerName ?? this.containerName]);
    }
    return this.status();
  }

  async stop(): Promise<N8nHealthSnapshot> {
    const instance = await this.readInstance();
    if (instance?.mode === 'managed-local-docker') {
      await this.runner('docker', ['stop', instance.containerName ?? this.containerName]);
      return this.status();
    }
    const snapshot = await this.status();
    return { ...snapshot, status: 'stopped' };
  }

  async restart(): Promise<N8nHealthSnapshot> {
    const instance = await this.readInstance();
    if (instance?.mode === 'managed-local-docker') {
      await this.runner('docker', ['restart', instance.containerName ?? this.containerName]);
    }
    return this.status();
  }

  async delete(input: DeleteN8nInstanceInput = {}): Promise<N8nHealthSnapshot> {
    if (input.destroyData && !input.force) {
      throw new Error('Refusing to destroy n8n data without force=true.');
    }

    const instance = await this.readInstance();
    if (instance?.mode === 'managed-local-docker') {
      const containerName = instance.containerName ?? this.containerName;
      await this.removeDockerContainer(containerName);
      if (input.destroyData) {
        await this.runner('docker', ['volume', 'rm', instance.volumeName ?? this.volumeName]);
      }
    }

    await fs.rm(this.statePath, { force: true });
    return {
      status: 'not-configured',
      checks: [{
        id: 'instance',
        label: 'n8n instance',
        status: 'pass',
        message: input.destroyData
          ? 'Instance configuration and managed Docker data deleted.'
          : 'Instance configuration deleted.',
      }],
    };
  }

  private async ensureDockerContainer(): Promise<void> {
    await this.requireDocker();

    const existing = await this.inspectDockerContainer(this.containerName);
    if (existing.exists) {
      if (existing.running) {
        return;
      }
      await this.runner('docker', ['start', this.containerName]);
      return;
    }

    await this.runner('docker', ['volume', 'create', this.volumeName]);
    await this.runner('docker', [
      'run',
      '-d',
      '--name',
      this.containerName,
      '-p',
      `${this.port}:5678`,
      '-e',
      'N8N_SECURE_COOKIE=false',
      '-e',
      'N8N_HOST=127.0.0.1',
      '-e',
      `N8N_PORT=5678`,
      '-v',
      `${this.volumeName}:/home/node/.n8n`,
      this.dockerImage,
    ]);
  }

  private async requireDocker(): Promise<void> {
    try {
      await this.runner('docker', ['version', '--format', '{{.Server.Version}}']);
    } catch (error) {
      throw new Error(`Docker is required to create managed local n8n. Start Docker and retry. ${formatCommandError(error)}`);
    }
  }

  private async resolveStatus(instance: N8nInstanceRef): Promise<N8nInstanceStatus> {
    if (instance.mode === 'generation-only') {
      return 'stopped';
    }

    if (instance.mode !== 'managed-local-docker') {
      return 'ready';
    }

    const inspected = await this.inspectDockerContainer(instance.containerName ?? this.containerName);
    if (!inspected.exists) {
      return 'not-configured';
    }
    return inspected.running ? 'ready' : 'stopped';
  }

  private async resolveChecks(instance: N8nInstanceRef): Promise<N8nHealthSnapshot['checks']> {
    if (instance.mode === 'generation-only') {
      return [{ id: 'instance', label: 'n8n instance', status: 'skip', message: 'Runtime disabled by generation-only mode.' }];
    }

    if (instance.mode !== 'managed-local-docker') {
      return [{ id: 'instance', label: 'n8n instance', status: 'pass', message: 'External instance configuration is present.' }];
    }

    try {
      await this.requireDocker();
      const inspected = await this.inspectDockerContainer(instance.containerName ?? this.containerName);
      if (!inspected.exists) {
        return [{ id: 'docker-container', label: 'Docker container', status: 'fail', message: 'Managed n8n container does not exist.' }];
      }

      return [{
        id: 'docker-container',
        label: 'Docker container',
        status: inspected.running ? 'pass' : 'warn',
        message: inspected.running
          ? `Container ${instance.containerName ?? this.containerName} is running at ${instance.baseUrl ?? `http://127.0.0.1:${this.port}`}.`
          : `Container ${instance.containerName ?? this.containerName} exists but is stopped.`,
      }];
    } catch (error) {
      return [{ id: 'docker', label: 'Docker', status: 'fail', message: formatCommandError(error) }];
    }
  }

  private async inspectDockerContainer(containerName: string): Promise<{ exists: boolean; running: boolean }> {
    try {
      const result = await this.runner('docker', ['inspect', '-f', '{{.State.Running}}', containerName]);
      return { exists: true, running: result.stdout.trim() === 'true' };
    } catch {
      return { exists: false, running: false };
    }
  }

  private async removeDockerContainer(containerName: string): Promise<void> {
    const inspected = await this.inspectDockerContainer(containerName);
    if (!inspected.exists) {
      return;
    }
    await this.runner('docker', ['rm', '-f', containerName]);
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

function formatCommandError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
