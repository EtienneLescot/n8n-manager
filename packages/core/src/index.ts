import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fssync from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  N8nConfigurationService,
  type EffectiveN8nContext,
  type GlobalN8nInstance,
} from './configuration-service.js';
import {
  ensureLocalN8nAuthBridgeRunning,
  getManagedN8nAuthBridgeOpenUrl,
  getLocalN8nAuthBridgeStatus,
  stopLocalN8nAuthBridgePublicTunnel,
} from './agent-tooling.js';
import { withFileLock } from './file-lock.js';
import { startDetachedProcess } from './process-utils.js';

export * from './configuration-service.js';
export * from './agent-tooling.js';

export type N8nInstanceMode = 'managed-local-docker' | 'managed-local-direct' | 'existing' | 'generation-only';

export type N8nInstanceStatus = 'unknown' | 'not-configured' | 'starting' | 'ready' | 'unhealthy' | 'stopped';

export interface N8nInstanceRef {
  id: string;
  mode: N8nInstanceMode;
  baseUrl?: string;
  runtimeStatePath?: string;
  apiKeyRef?: string;
  projectName?: string;
  provider?: 'docker' | 'external' | 'none';
  containerName?: string;
  volumeName?: string;
  image?: string;
  databaseType?: 'sqlite';
  databasePath?: string;
  apiKey?: string;
  apiKeyScopes?: string[];
  apiKeyAvailable?: boolean;
  publicUrlEnabled?: boolean;
  desiredState?: 'running' | 'stopped';
  warnings?: string[];
  ownerEmail?: string;
  ownerPassword?: string;
  ownerFirstName?: string;
  ownerLastName?: string;
  ownerCredentialsAvailable?: boolean;
  tunnelPublicUrl?: string;
  tunnelTargetUrl?: string;
  tunnelPid?: number;
  tunnelLastAttemptAt?: string;
  tunnelLastError?: string;
  tunnelNextRetryAt?: string;
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

export type N8nTunnelAction = 'ensure' | 'start' | 'refresh';

export interface N8nTunnelSnapshot {
  enabled: boolean;
  running: boolean;
  publicUrl?: string;
  targetUrl?: string;
  pid?: number;
  startedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  nextRetryAt?: string;
}

export interface N8nRuntimeStatusSnapshot extends N8nHealthSnapshot {
  instanceId?: string;
  managed: boolean;
  ready: boolean;
  blocked?: {
    code: 'docker-unavailable' | 'runtime-missing' | 'runtime-unhealthy' | 'api-key-missing' | 'not-managed';
    message: string;
  };
  tunnel?: N8nTunnelSnapshot;
  authBridgeTunnel?: N8nTunnelSnapshot;
  authBridgeOpenUrl?: string;
  warnings?: string[];
}

export type N8nRuntimeConsumer = 'vscode' | 'cli' | 'plugin' | 'agent' | 'manager';
const TUNNEL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export type N8nInstanceAccessMode = 'observe' | 'reconcile';

export interface ResolveN8nInstanceAccessInput {
  workspaceRoot?: string;
  instanceId?: string;
  syncFolderDefault?: import('./configuration-service.js').N8nSyncFolderDefaultPolicy;
  mode?: N8nInstanceAccessMode;
  refreshPublicUrl?: boolean;
  targetPath?: string;
  consumer?: N8nRuntimeConsumer;
}

export interface N8nInstanceAccessSnapshot {
  instanceId: string;
  instanceName: string;
  apiBaseUrl: string;
  publicN8nUrl?: string;
  authUrl?: string;
  publicUrlEnabled: boolean;
  desiredState?: 'running' | 'stopped';
  runtimeStatus: N8nInstanceStatus;
  ready: boolean;
  blocked?: N8nRuntimeStatusSnapshot['blocked'];
  tunnel?: N8nTunnelSnapshot;
  authBridge?: N8nTunnelSnapshot;
  warnings: string[];
}

export interface PreparedEffectiveN8nContext {
  context: EffectiveN8nContext;
  runtime: N8nRuntimeStatusSnapshot;
  diagnostics: Array<{
    code: string;
    level: 'info' | 'warning' | 'error';
    message: string;
  }>;
}

export interface N8nProjectSnapshot {
  id: string;
  name: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  fallback?: boolean;
}

export interface N8nLifecycleManager {
  setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string; tunnel?: boolean; bootstrapOwner?: boolean }): Promise<N8nInstanceRef>;
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
  fetch?: typeof fetch;
  instanceId?: string;
  dockerImage?: string;
  containerName?: string;
  volumeName?: string;
  port?: number;
  bootstrapOwner?: boolean;
  tunnel?: boolean;
  cloudflaredBin?: string;
  waitForReady?: boolean;
}

const execFileAsync = promisify(execFile);

const DEFAULT_DOCKER_IMAGE = 'n8nio/n8n:latest';
const DEFAULT_CONTAINER_NAME = 'n8n-manager-local';
const DEFAULT_VOLUME_NAME = 'n8n-manager-local-data';
const DEFAULT_PORT = 5678;
const N8N_CONTAINER_DATA_DIR = '/home/node/.n8n';
const N8N_SQLITE_DATABASE_PATH = `${N8N_CONTAINER_DATA_DIR}/database.sqlite`;
const DEFAULT_HEALTH_TIMEOUT_MS = 300_000;
const DEFAULT_EDITOR_TIMEOUT_MS = 90_000;
const DEFAULT_OWNER_BOOTSTRAP_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const OWNER_SETUP_PATH = '/rest/owner/setup';
const LOGIN_PATH = '/rest/login';
const API_KEYS_PATH = '/rest/api-keys';
const SURVEY_PATH = '/rest/me/survey';
const COMMUNITY_LICENSE_PATH = '/rest/license/enterprise/community-registered';
const DEFAULT_API_KEY_SCOPES = [
  'user:read',
  'user:list',
  'project:list',
  'workflow:read',
  'workflow:list',
  'workflow:create',
  'workflow:update',
  'workflow:delete',
  'workflow:activate',
  'workflow:deactivate',
  'credential:list',
  'credential:create',
  'credential:update',
  'credential:delete',
  'execution:read',
  'execution:list',
];

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
  private readonly fetcher: typeof fetch;
  private readonly instanceId: string;
  private readonly dockerImage: string;
  private readonly containerName: string;
  private readonly volumeName: string;
  private port: number;
  private readonly bootstrapOwnerDefault: boolean;
  private readonly tunnelDefault: boolean;
  private readonly cloudflaredBin?: string;
  private readonly waitForReady: boolean;

  constructor(
    private readonly statePath = resolveFileBackedN8nStatePath(),
    options: FileBackedN8nLifecycleManagerOptions = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
    this.fetcher = options.fetch ?? fetch;
    this.dockerImage = options.dockerImage ?? process.env.N8N_MANAGER_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
    this.containerName = options.containerName ?? process.env.N8N_MANAGER_DOCKER_CONTAINER ?? DEFAULT_CONTAINER_NAME;
    this.instanceId = options.instanceId ?? this.containerName;
    this.volumeName = options.volumeName ?? process.env.N8N_MANAGER_DOCKER_VOLUME ?? DEFAULT_VOLUME_NAME;
    this.port = Number(options.port ?? process.env.N8N_MANAGER_DOCKER_PORT ?? DEFAULT_PORT);
    this.bootstrapOwnerDefault = options.bootstrapOwner ?? process.env.N8N_MANAGER_BOOTSTRAP_OWNER !== 'false';
    this.tunnelDefault = options.tunnel ?? process.env.N8N_MANAGER_TUNNEL === 'true';
    this.cloudflaredBin = options.cloudflaredBin ?? process.env.N8N_MANAGER_CLOUDFLARED_BIN;
    this.waitForReady = options.waitForReady ?? process.env.N8N_MANAGER_WAIT_FOR_READY !== 'false';
  }

  async setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string; tunnel?: boolean; bootstrapOwner?: boolean }): Promise<N8nInstanceRef> {
    const existingState = await this.readInstance();
    const shouldTunnel = input.tunnel ?? existingState?.publicUrlEnabled ?? this.tunnelDefault;
    const shouldBootstrapOwner = input.bootstrapOwner ?? this.bootstrapOwnerDefault;

    if (input.mode === 'managed-local-docker') {
      await this.ensureDockerContainer(existingState?.tunnelPublicUrl);
      if (this.waitForReady) {
        await this.waitForN8nReady(`http://127.0.0.1:${this.port}`);
      }
    }

    const baseUrl = input.mode === 'managed-local-docker' ? `http://127.0.0.1:${this.port}` : input.baseUrl;
    const ownerBootstrap = input.mode === 'managed-local-docker' && shouldBootstrapOwner
      ? await this.bootstrapManagedOwner(baseUrl)
      : undefined;
    const warnings: string[] = [];
    let tunnel: { publicUrl: string; targetUrl: string; pid: number } | undefined;
    let tunnelLastAttemptAt: string | undefined;
    let tunnelLastError: string | undefined;
    let tunnelNextRetryAt: string | undefined;
    if (input.mode === 'managed-local-docker' && shouldTunnel) {
      if (existingState && shouldSkipTunnelAttempt(existingState, 'ensure')) {
        tunnelLastAttemptAt = existingState.tunnelLastAttemptAt;
        tunnelLastError = existingState.tunnelLastError;
        tunnelNextRetryAt = existingState.tunnelNextRetryAt;
        warnings.push(`Public URL creation is temporarily paused after a previous Cloudflare failure.${tunnelNextRetryAt ? ` Next retry after ${tunnelNextRetryAt}.` : ''}${tunnelLastError ? ` ${tunnelLastError}` : ''}`);
      } else {
        tunnelLastAttemptAt = new Date().toISOString();
        try {
                    tunnel = await this.withTunnelLock(() => this.ensureTunnel(baseUrl, 'ensure', existingState));
        } catch (error) {
          tunnelLastError = formatCommandError(error);
          tunnelNextRetryAt = new Date(Date.now() + TUNNEL_RETRY_COOLDOWN_MS).toISOString();
          warnings.push(`Public URL could not be created: ${tunnelLastError}`);
        }
      }
    } else if (existingState?.tunnelPublicUrl && existingState.tunnelPid) {
      tunnel = { publicUrl: existingState.tunnelPublicUrl, targetUrl: existingState.tunnelTargetUrl ?? existingState.baseUrl ?? existingState.tunnelPublicUrl, pid: existingState.tunnelPid };
    }
    const tunnelAlreadyApplied = existingState?.tunnelPublicUrl === tunnel?.publicUrl
      && existingState?.tunnelTargetUrl === baseUrl
      && existingState?.tunnelPid === tunnel?.pid;
    if (input.mode === 'managed-local-docker' && tunnel?.publicUrl && !tunnelAlreadyApplied) {
      await this.recreateDockerContainerForTunnel(tunnel.publicUrl);
      if (this.waitForReady && baseUrl) {
        await this.waitForN8nReady(baseUrl);
      }
    }

    const instance: N8nInstanceRef = {
      id: input.mode === 'managed-local-docker' ? this.instanceId : (input.baseUrl ?? input.mode),
      mode: input.mode,
      baseUrl,
      runtimeStatePath: this.statePath,
      apiKeyRef: ownerBootstrap?.apiKey ? 'managed-local-owner-api-key' : input.apiKeyRef,
      provider: input.mode === 'managed-local-docker'
        ? 'docker'
        : input.mode === 'existing'
          ? 'external'
          : 'none',
      containerName: input.mode === 'managed-local-docker' ? this.containerName : undefined,
      volumeName: input.mode === 'managed-local-docker' ? this.volumeName : undefined,
      image: input.mode === 'managed-local-docker' ? this.dockerImage : undefined,
      databaseType: input.mode === 'managed-local-docker' ? 'sqlite' : undefined,
      databasePath: input.mode === 'managed-local-docker' ? N8N_SQLITE_DATABASE_PATH : undefined,
      apiKey: ownerBootstrap?.apiKey ?? existingState?.apiKey,
      apiKeyScopes: ownerBootstrap?.apiKeyScopes ?? existingState?.apiKeyScopes,
      ownerEmail: ownerBootstrap?.ownerEmail ?? existingState?.ownerEmail,
      ownerPassword: ownerBootstrap?.ownerPassword ?? existingState?.ownerPassword,
      ownerFirstName: ownerBootstrap?.ownerFirstName ?? existingState?.ownerFirstName,
      ownerLastName: ownerBootstrap?.ownerLastName ?? existingState?.ownerLastName,
      publicUrlEnabled: shouldTunnel,
      desiredState: 'running',
      tunnelPublicUrl: tunnel?.publicUrl,
      tunnelTargetUrl: shouldTunnel ? (tunnel?.targetUrl ?? baseUrl) : undefined,
      tunnelPid: tunnel?.pid,
      tunnelLastAttemptAt,
      tunnelLastError: tunnel ? undefined : tunnelLastError,
      tunnelNextRetryAt: tunnel ? undefined : tunnelNextRetryAt,
      warnings: warnings.length ? warnings : undefined,
    };
    await this.writeInstance(instance);
    return toPublicInstance(instance);
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
      instance: toPublicInstance(instance),
      checks: await this.resolveChecks(instance),
    };
  }

  async start(): Promise<N8nHealthSnapshot> {
    const instance = await this.readInstance();
    if (instance?.mode === 'managed-local-docker') {
      await this.requireDocker();
      const inspected = await this.inspectDockerContainer(instance.containerName ?? this.containerName);
      if (!inspected.exists) {
        await this.ensureDockerContainer(instance.tunnelPublicUrl);
      } else if (!inspected.running) {
        try {
          await this.runner('docker', ['start', instance.containerName ?? this.containerName]);
        } catch (error) {
          if (!isDockerPortUnavailableError(error)) {
            throw error;
          }
          await this.removeDockerContainer(instance.containerName ?? this.containerName);
          await this.runDockerContainerWithPortFallback(instance.tunnelPublicUrl);
        }
      }
      const next = await this.updateManagedLocalBaseUrlIfNeeded(instance);
      if (this.waitForReady && next.baseUrl) {
        await this.waitForN8nReady(next.baseUrl);
      }
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
      await this.withTunnelLock(() => this.stopTunnel(instance, 'lifecycle.delete'));
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

  async ensurePublicTunnel(input: { action?: N8nTunnelAction; targetUrl?: string } = {}): Promise<N8nTunnelSnapshot> {
    return this.withTunnelLock(() => this.ensurePublicTunnelUnlocked(input));
  }

  private async ensurePublicTunnelUnlocked(input: { action?: N8nTunnelAction; targetUrl?: string } = {}): Promise<N8nTunnelSnapshot> {
    const instance = await this.readInstance();
    if (!instance || instance.mode !== 'managed-local-docker') {
      return { enabled: false, running: false };
    }

    const targetUrl = input.targetUrl ?? instance.baseUrl ?? `http://127.0.0.1:${this.port}`;
    let tunnel: { publicUrl: string; targetUrl: string; pid: number } | undefined;
    let tunnelError: string | undefined;
    let tunnelLastAttemptAt: string | undefined;
    let tunnelNextRetryAt: string | undefined;
    if (shouldSkipTunnelAttempt(instance, input.action ?? 'ensure')) {
      tunnelError = instance.tunnelLastError;
      tunnelLastAttemptAt = instance.tunnelLastAttemptAt;
      tunnelNextRetryAt = instance.tunnelNextRetryAt;
    } else {
      tunnelLastAttemptAt = new Date().toISOString();
      try {
        tunnel = await this.ensureTunnel(targetUrl, input.action ?? 'ensure', instance);
      } catch (error) {
        tunnelError = formatCommandError(error);
        tunnelNextRetryAt = new Date(Date.now() + TUNNEL_RETRY_COOLDOWN_MS).toISOString();
      }
    }
    const next = {
      ...instance,
      publicUrlEnabled: true,
      tunnelPublicUrl: tunnel?.publicUrl,
      tunnelTargetUrl: tunnel?.targetUrl ?? targetUrl,
      tunnelPid: tunnel?.pid,
      tunnelLastAttemptAt,
      tunnelLastError: tunnel ? undefined : tunnelError,
      tunnelNextRetryAt: tunnel ? undefined : tunnelNextRetryAt,
    };
    await this.writeInstance(next);

    const tunnelAlreadyApplied = instance.tunnelPublicUrl === tunnel?.publicUrl
      && instance.tunnelTargetUrl === targetUrl
      && instance.tunnelPid === tunnel?.pid;
    if (tunnel?.publicUrl && !tunnelAlreadyApplied) {
      await this.recreateDockerContainerForTunnel(tunnel.publicUrl);
      if (this.waitForReady && instance.baseUrl) {
        await this.waitForN8nReady(instance.baseUrl);
      }
    }

    return {
      enabled: true,
      running: Boolean(tunnel?.pid && isPidAlive(tunnel.pid)),
      publicUrl: tunnel?.publicUrl,
      targetUrl: tunnel?.targetUrl ?? targetUrl,
      pid: tunnel?.pid,
      lastAttemptAt: tunnelLastAttemptAt,
      lastError: tunnelError,
      nextRetryAt: tunnelNextRetryAt,
    };
  }

  async stopPublicTunnel(input: { disable?: boolean } = {}): Promise<N8nTunnelSnapshot> {
    return this.withTunnelLock(() => this.stopPublicTunnelUnlocked(input));
  }

  private async stopPublicTunnelUnlocked(input: { disable?: boolean } = {}): Promise<N8nTunnelSnapshot> {
    const instance = await this.readInstance();
    if (!instance) {
      return { enabled: false, running: false };
    }
    await this.stopTunnel(instance, `lifecycle.stopPublicTunnel(disable=${input.disable !== false})`);
    await this.writeInstance({
      ...instance,
      publicUrlEnabled: input.disable === false ? instance.publicUrlEnabled : false,
      tunnelPublicUrl: undefined,
      tunnelTargetUrl: input.disable === false ? (instance.tunnelTargetUrl ?? instance.baseUrl) : undefined,
      tunnelPid: undefined,
      tunnelLastAttemptAt: undefined,
      tunnelLastError: undefined,
      tunnelNextRetryAt: undefined,
    });
    return { enabled: input.disable === false && Boolean(instance.publicUrlEnabled), running: false };
  }

  async getPublicTunnelStatus(): Promise<N8nTunnelSnapshot> {
    const instance = await this.readInstance();
    if (!instance?.publicUrlEnabled && !instance?.tunnelPublicUrl) {
      return { enabled: false, running: false };
    }
    if (!instance.tunnelPublicUrl) {
      return {
        enabled: true,
        running: false,
        targetUrl: instance.tunnelTargetUrl ?? instance.baseUrl,
        lastAttemptAt: instance.tunnelLastAttemptAt,
        lastError: instance.tunnelLastError,
        nextRetryAt: instance.tunnelNextRetryAt,
      };
    }
    const running = Boolean(instance.tunnelPid && isPidAlive(instance.tunnelPid));
    return {
      enabled: true,
      running,
      publicUrl: instance.tunnelPublicUrl,
      targetUrl: instance.tunnelTargetUrl,
      pid: running ? instance.tunnelPid : undefined,
      lastAttemptAt: instance.tunnelLastAttemptAt,
      lastError: running ? undefined : instance.tunnelLastError,
      nextRetryAt: running ? undefined : instance.tunnelNextRetryAt,
    };
  }

  private async ensureDockerContainer(tunnelPublicUrl?: string): Promise<void> {
    await this.requireDocker();

    const existing = await this.inspectDockerContainer(this.containerName);
    if (existing.exists) {
      if (existing.running) {
        return;
      }
      try {
        await this.runner('docker', ['start', this.containerName]);
      } catch (error) {
        if (!isDockerPortUnavailableError(error)) {
          throw error;
        }
        await this.removeDockerContainer(this.containerName);
        await this.runDockerContainerWithPortFallback(tunnelPublicUrl);
      }
      return;
    }

    await this.runDockerContainerWithPortFallback(tunnelPublicUrl);
  }

  private async runDockerContainerWithPortFallback(tunnelPublicUrl?: string): Promise<void> {
    await this.runner('docker', ['volume', 'create', this.volumeName]);
    try {
      await this.runner('docker', this.buildDockerRunArgs(tunnelPublicUrl));
      return;
    } catch (error) {
      if (!isDockerPortUnavailableError(error)) {
        throw error;
      }
      this.port = await findAvailableHostPort(this.port + 1);
      await this.runner('docker', this.buildDockerRunArgs(tunnelPublicUrl));
    }
  }

  private buildDockerRunArgs(tunnelPublicUrl?: string): string[] {
    const editorBaseUrl = tunnelPublicUrl ?? `http://127.0.0.1:${this.port}`;
    const args = [
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
      '-e',
      'N8N_LISTEN_ADDRESS=0.0.0.0',
      '-e',
      'N8N_PROTOCOL=http',
      '-e',
      'DB_TYPE=sqlite',
      '-e',
      `N8N_EDITOR_BASE_URL=${editorBaseUrl}`,
      '-e',
      'QUEUE_HEALTH_CHECK_ACTIVE=true',
    ];
    if (tunnelPublicUrl) {
      args.push('-e', `N8N_WEBHOOK_URL=${tunnelPublicUrl}`);
    }
    args.push(
      '-v',
      `${this.volumeName}:${N8N_CONTAINER_DATA_DIR}`,
      this.dockerImage,
    );
    return args;
  }

  private async recreateDockerContainerForTunnel(tunnelPublicUrl: string): Promise<void> {
    const inspected = await this.inspectDockerContainer(this.containerName);
    if (!inspected.exists) {
      return;
    }
    await this.runner('docker', ['rm', '-f', this.containerName]);
    await this.runDockerContainerWithPortFallback(tunnelPublicUrl);
  }

  private async updateManagedLocalBaseUrlIfNeeded(instance: N8nInstanceRef): Promise<N8nInstanceRef> {
    const baseUrl = `http://127.0.0.1:${this.port}`;
    if (instance.baseUrl === baseUrl) {
      return instance;
    }
    const next = {
      ...instance,
      baseUrl,
      tunnelTargetUrl: instance.tunnelTargetUrl === instance.baseUrl ? baseUrl : instance.tunnelTargetUrl,
    };
    await this.writeInstance(next);
    return next;
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
    const checks: N8nHealthSnapshot['checks'] = [];
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

      checks.push({
        id: 'docker-container',
        label: 'Docker container',
        status: inspected.running ? 'pass' : 'warn',
        message: inspected.running
          ? `Container ${instance.containerName ?? this.containerName} is running at ${instance.baseUrl ?? `http://127.0.0.1:${this.port}`}.`
          : `Container ${instance.containerName ?? this.containerName} exists but is stopped.`,
      });

      if (instance.apiKey) {
        checks.push({ id: 'owner-api-key', label: 'Owner API key', status: 'pass', message: 'Managed owner API key is available.' });
      } else {
        checks.push({ id: 'owner-api-key', label: 'Owner API key', status: 'warn', message: 'Managed owner/API key bootstrap is not complete.' });
      }

      if (instance.tunnelPublicUrl) {
        checks.push({
          id: 'tunnel',
          label: 'Public tunnel',
          status: instance.tunnelPid && isPidAlive(instance.tunnelPid) ? 'pass' : 'warn',
          message: instance.tunnelPid && isPidAlive(instance.tunnelPid)
            ? `Public tunnel is active at ${instance.tunnelPublicUrl}.`
            : `Tunnel URL ${instance.tunnelPublicUrl} is stored, but the tunnel process is not running.`,
        });
      } else {
        checks.push({ id: 'tunnel', label: 'Public tunnel', status: 'skip', message: 'No public tunnel requested.' });
      }

      return checks;
    } catch (error) {
      return [{ id: 'docker', label: 'Docker', status: 'fail', message: formatCommandError(error) }];
    }
  }

  private async waitForN8nReady(baseUrl: string): Promise<void> {
    await this.waitForHealth(baseUrl);
    await this.waitForEditorBestEffort(baseUrl);
  }

  private async waitForHealth(baseUrl: string, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetcher(`${baseUrl}/healthz`);
        if (response.ok) {
          return;
        }
      } catch {
        // retry
      }
      await delay(1500);
    }
    throw new Error(`Timed out waiting for ${baseUrl} to become healthy.`);
  }

  private async waitForEditorBestEffort(baseUrl: string): Promise<void> {
    const deadline = Date.now() + DEFAULT_EDITOR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetcher(baseUrl);
        const body = await response.text();
        if (response.ok && body.trim() && !body.toLowerCase().includes('n8n is starting up')) {
          return;
        }
      } catch {
        // retry
      }
      await delay(1500);
    }
  }

  private async bootstrapManagedOwner(baseUrl?: string): Promise<ManagedOwnerBootstrap> {
    if (!baseUrl) {
      return {};
    }

    const existing = await this.readInstance();
    if (existing?.apiKey && hasRequiredApiKeyScopes(existing.apiKeyScopes)) {
      const usable = await this.isApiKeyUsable(baseUrl, existing.apiKey);
      if (usable) {
        return {
          apiKey: existing.apiKey,
          apiKeyScopes: existing.apiKeyScopes,
          ownerEmail: existing.ownerEmail,
          ownerPassword: existing.ownerPassword,
          ownerFirstName: existing.ownerFirstName,
          ownerLastName: existing.ownerLastName,
        };
      }
    }

    const ownerCredentials = await this.resolveManagedOwnerCredentials(baseUrl, existing);
    await this.persistManagedOwnerCredentials(baseUrl, ownerCredentials, existing);

    try {
      const sessionCookie = await retryBootstrapStep('owner setup/login', async () => {
        return await this.setupOwner(baseUrl, ownerCredentials);
      });
      const apiKey = await retryBootstrapStep('api key creation', async () => await this.createApiKey(baseUrl, sessionCookie));
      await this.finalizeManagedLocalN8nReadiness(baseUrl, sessionCookie, ownerCredentials?.email);
      return {
        apiKey,
        apiKeyScopes: DEFAULT_API_KEY_SCOPES,
        ownerEmail: ownerCredentials.email,
        ownerPassword: ownerCredentials.password,
        ownerFirstName: ownerCredentials.firstName,
        ownerLastName: ownerCredentials.lastName,
      };
    } catch (error) {
      const resetBootstrap = await this.tryResetManagedOwnerAndBootstrap(baseUrl, ownerCredentials, error);
      if (resetBootstrap) {
        return resetBootstrap;
      }

      if (existing?.apiKey && hasRequiredApiKeyScopes(existing.apiKeyScopes)) {
        const usable = await this.isApiKeyUsable(baseUrl, existing.apiKey);
        if (usable) {
          return {
            apiKey: existing.apiKey,
            apiKeyScopes: existing.apiKeyScopes,
            ownerEmail: existing.ownerEmail,
            ownerPassword: existing.ownerPassword,
            ownerFirstName: existing.ownerFirstName,
            ownerLastName: existing.ownerLastName,
          };
        }
      }
      throw new Error(`Managed local n8n is running, but owner/API key bootstrap failed: ${formatCommandError(error)}`);
    }
  }

  private async tryResetManagedOwnerAndBootstrap(
    baseUrl: string,
    ownerCredentials: ManagedOwnerCredentials,
    originalError: unknown,
  ): Promise<ManagedOwnerBootstrap | undefined> {
    if (process.env.N8N_MANAGER_RESET_STALE_OWNER === 'false') {
      return undefined;
    }

    const message = formatCommandError(originalError).toLowerCase();
    const staleOwnerCredentials = message.includes('wrong username or password')
      || message.includes('owner login failed with 401')
      || message.includes('owner login failed with 429');
    if (!staleOwnerCredentials) {
      return undefined;
    }

    await this.runner('docker', ['exec', this.containerName, 'n8n', 'user-management:reset']);
    if (this.waitForReady) {
      await this.waitForN8nReady(baseUrl);
    }

    const sessionCookie = await retryBootstrapStep('owner setup after user reset', async () => {
      return await this.setupOwner(baseUrl, ownerCredentials);
    });
    const apiKey = await retryBootstrapStep('api key creation after user reset', async () => await this.createApiKey(baseUrl, sessionCookie));
    await this.finalizeManagedLocalN8nReadiness(baseUrl, sessionCookie, ownerCredentials.email);
    return {
      apiKey,
      apiKeyScopes: DEFAULT_API_KEY_SCOPES,
      ownerEmail: ownerCredentials.email,
      ownerPassword: ownerCredentials.password,
      ownerFirstName: ownerCredentials.firstName,
      ownerLastName: ownerCredentials.lastName,
    };
  }

  private async isApiKeyUsable(baseUrl: string, apiKey: string): Promise<boolean> {
    try {
      const response = await this.fetcher(buildUrl(baseUrl, '/api/v1/workflows'), {
        headers: { 'X-N8N-API-KEY': apiKey },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async setupOwner(baseUrl: string, credentials: ManagedOwnerCredentials): Promise<string> {
    const response = await this.fetcher(buildUrl(baseUrl, OWNER_SETUP_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: credentials.email,
        firstName: credentials.firstName,
        lastName: credentials.lastName,
        password: credentials.password,
      }),
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      try {
        return await this.loginOwner(baseUrl, credentials);
      } catch (loginError) {
        throw new Error(
          `Owner setup failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ''}; `
          + `stored owner login also failed: ${formatCommandError(loginError)}.`,
        );
      }
    }

    const authCookie = extractCookie(response.headers.get('set-cookie'), 'n8n-auth');
    if (authCookie) {
      return authCookie;
    }
    return await this.loginOwner(baseUrl, credentials);
  }

  private async loginOwner(baseUrl: string, credentials: ManagedOwnerCredentials): Promise<string> {
    const response = await this.fetcher(buildUrl(baseUrl, LOGIN_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        emailOrLdapLoginId: credentials.email,
        password: credentials.password,
      }),
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`Owner login failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ''}.`);
    }

    const authCookie = extractCookie(response.headers.get('set-cookie'), 'n8n-auth');
    if (!authCookie) {
      throw new Error('Owner login did not return an authenticated n8n session cookie.');
    }
    return authCookie;
  }

  private async createApiKey(baseUrl: string, sessionCookie: string): Promise<string> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.createApiKeyAttempt(baseUrl, sessionCookie, buildApiKeyLabel(attempt));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!lastError.message.includes('There is already an entry with this name')) {
          throw lastError;
        }
      }
    }
    throw lastError ?? new Error('API key creation failed.');
  }

  private async createApiKeyAttempt(baseUrl: string, sessionCookie: string, label: string): Promise<string> {
    const response = await this.fetcher(buildUrl(baseUrl, API_KEYS_PATH), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sessionCookie,
      },
      body: JSON.stringify({
        label,
        scopes: DEFAULT_API_KEY_SCOPES,
        expiresAt: null,
      }),
    });

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`API key creation failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ''}.`);
    }

    const payload = await response.json() as { data?: { rawApiKey?: string } };
    const apiKey = payload.data?.rawApiKey;
    if (!apiKey) {
      throw new Error('API key creation succeeded but no raw API key was returned.');
    }
    return apiKey;
  }

  private async finalizeManagedLocalN8nReadiness(baseUrl: string, sessionCookie: string, email?: string): Promise<void> {
    const ownerEmail = email ?? 'n8n-manager-local@localhost';
    await retryBootstrapStep('personalization survey submission', async () => {
      const response = await this.fetcher(buildUrl(baseUrl, SURVEY_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({
          version: 'v4',
          personalization_survey_submitted_at: new Date().toISOString(),
          personalization_survey_n8n_version: 'n8n-manager',
          companySize: 'personalUser',
          companyType: 'personal',
          role: 'engineering',
          reportedSource: 'other',
          reportedSourceOther: 'n8n-manager-local',
          usageModes: ['own'],
          companyIndustryExtended: ['technology'],
          email: ownerEmail,
        }),
      });
      if (!response.ok) throw new Error(`Survey submission failed with ${response.status} ${response.statusText}.`);
    }).catch(() => undefined);

    await retryBootstrapStep('community license registration', async () => {
      const response = await this.fetcher(buildUrl(baseUrl, COMMUNITY_LICENSE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ email: ownerEmail }),
      });
      if (response.ok || response.status === 409) return;
      throw new Error(`Community registration failed with ${response.status} ${response.statusText}.`);
    }).catch(() => undefined);
  }

  private async resolveManagedOwnerCredentials(
    baseUrl: string,
    existing?: N8nInstanceRef,
  ): Promise<ManagedOwnerCredentials> {
    if (existing?.ownerEmail && existing.ownerPassword) {
      return {
        email: existing.ownerEmail,
        password: existing.ownerPassword,
        firstName: existing.ownerFirstName ?? 'n8n',
        lastName: existing.ownerLastName ?? 'Manager',
      };
    }

    const envEmail = process.env.N8N_MANAGER_OWNER_EMAIL;
    const envPassword = process.env.N8N_MANAGER_OWNER_PASSWORD;
    if (envEmail && envPassword) {
      return {
        email: envEmail,
        password: envPassword,
        firstName: process.env.N8N_MANAGER_OWNER_FIRST_NAME ?? 'n8n',
        lastName: process.env.N8N_MANAGER_OWNER_LAST_NAME ?? 'Manager',
      };
    }

    return buildGeneratedOwnerCredentials(baseUrl);
  }

  private async persistManagedOwnerCredentials(
    baseUrl: string,
    credentials: ManagedOwnerCredentials,
    existing?: N8nInstanceRef,
  ): Promise<void> {
    await this.writeInstance({
      id: existing?.id ?? this.instanceId,
      mode: existing?.mode ?? 'managed-local-docker',
      baseUrl: existing?.baseUrl ?? baseUrl,
      runtimeStatePath: existing?.runtimeStatePath ?? this.statePath,
      apiKeyRef: existing?.apiKeyRef,
      projectName: existing?.projectName,
      provider: existing?.provider ?? 'docker',
      containerName: existing?.containerName ?? this.containerName,
      volumeName: existing?.volumeName ?? this.volumeName,
      image: existing?.image ?? this.dockerImage,
      databaseType: existing?.databaseType ?? 'sqlite',
      databasePath: existing?.databasePath ?? N8N_SQLITE_DATABASE_PATH,
      apiKey: existing?.apiKey,
      apiKeyScopes: existing?.apiKeyScopes,
      ownerEmail: credentials.email,
      ownerPassword: credentials.password,
      ownerFirstName: credentials.firstName,
      ownerLastName: credentials.lastName,
      publicUrlEnabled: existing?.publicUrlEnabled,
      tunnelPublicUrl: existing?.tunnelPublicUrl,
      tunnelTargetUrl: existing?.tunnelTargetUrl,
      tunnelPid: existing?.tunnelPid,
    });
  }

  private async ensureTunnel(
    targetUrl?: string,
    action: N8nTunnelAction = 'ensure',
    existingState?: N8nInstanceRef,
  ): Promise<{ publicUrl: string; targetUrl: string; pid: number } | undefined> {
    if (!targetUrl) {
      return undefined;
    }

    if (
      action !== 'refresh'
      && existingState?.tunnelPid
      && existingState.tunnelPublicUrl
      && existingState.tunnelTargetUrl === targetUrl
      && isPidAlive(existingState.tunnelPid)
    ) {
      return {
        publicUrl: existingState.tunnelPublicUrl,
        targetUrl,
        pid: existingState.tunnelPid,
      };
    }

    if (existingState?.tunnelPid && isPidAlive(existingState.tunnelPid)) {
      await this.stopTunnel(existingState, 'lifecycle.ensureTunnel.replace-existing');
    }

    const bin = await installCloudflaredIfNeeded(this.cloudflaredBin);
    const logFile = path.join(path.dirname(this.statePath), `${this.instanceId}-cloudflared-${Date.now()}.log`);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const pid = await startDetachedProcess(bin, ['tunnel', '--url', targetUrl, '--no-autoupdate', '--logfile', logFile]);
    try {
      const publicUrl = await waitForTunnelPublicUrl(pid, logFile);
      return { publicUrl, targetUrl, pid };
    } catch (error) {
      await terminateProcess(pid, `lifecycle.ensureTunnel.failed:${this.instanceId}`);
      throw error;
    }
  }

  private async withTunnelLock<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(path.dirname(this.statePath), `${this.instanceId}.public-tunnel.lock`), action);
  }

  private async stopTunnel(instance: N8nInstanceRef, reason: string): Promise<void> {
    if (!instance.tunnelPid || !isPidAlive(instance.tunnelPid)) {
      return;
    }
    await terminateProcess(instance.tunnelPid, reason);
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
      return parsed.id && parsed.mode
        ? {
          ...parsed,
          publicUrlEnabled: parsed.publicUrlEnabled ?? false,
          desiredState: parsed.desiredState ?? (parsed.mode === 'managed-local-docker' ? 'running' : undefined),
        }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeInstance(instance: N8nInstanceRef): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(instance, null, 2));
  }
}

export async function readFileBackedN8nInstance(
  statePath?: string,
): Promise<N8nInstanceRef | undefined> {
  try {
    const content = await fs.readFile(resolveFileBackedN8nStatePath(statePath), 'utf-8');
    const parsed = JSON.parse(content) as N8nInstanceRef;
    return parsed.id && parsed.mode
      ? {
        ...parsed,
        publicUrlEnabled: parsed.publicUrlEnabled ?? false,
        desiredState: parsed.desiredState ?? (parsed.mode === 'managed-local-docker' ? 'running' : undefined),
      }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function testN8nApiConnection(input: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(buildUrl(input.baseUrl, '/api/v1/workflows'), {
    headers: { 'X-N8N-API-KEY': input.apiKey },
  });
  if (!response.ok) {
    const body = await safeReadText(response);
    throw new Error(`n8n API test failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ''}.`);
  }
}

export async function listN8nProjects(input: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<N8nProjectSnapshot[]> {
  const fetcher = input.fetch ?? fetch;
  const response = await fetcher(buildUrl(input.baseUrl, '/api/v1/projects'), {
    headers: { 'X-N8N-API-KEY': input.apiKey },
  });
  if (response.status === 403 || response.status === 404 || response.status === 405) {
    return [createPersonalProjectFallback()];
  }
  if (!response.ok) {
    const body = await safeReadText(response);
    throw new Error(`n8n projects API failed with ${response.status} ${response.statusText}${body ? `: ${body}` : ''}.`);
  }

  const payload = await response.json().catch(() => undefined) as { data?: unknown } | unknown[] | undefined;
  const rawProjects = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown } | undefined)?.data)
      ? (payload as { data: unknown[] }).data
      : [];
  const projects = rawProjects
    .filter((project): project is Record<string, unknown> => Boolean(project) && typeof project === 'object')
    .map((project) => ({
      id: String(project.id ?? '').trim(),
      name: String(project.name ?? '').trim() || (project.type === 'personal' ? 'Personal' : String(project.id ?? '').trim()),
      type: typeof project.type === 'string' ? project.type : undefined,
      createdAt: typeof project.createdAt === 'string' ? project.createdAt : undefined,
      updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : undefined,
    }))
    .filter((project) => project.id);

  return projects.length ? projects : [createPersonalProjectFallback()];
}

export function resolveFileBackedN8nStatePath(statePath?: string): string {
  const explicitStatePath = statePath?.trim() || process.env.N8N_MANAGER_STATE_PATH?.trim();
  if (explicitStatePath) {
    return path.resolve(explicitStatePath);
  }

  const explicitHome = process.env.N8N_MANAGER_HOME?.trim();
  return path.join(explicitHome ? path.resolve(explicitHome) : path.join(os.homedir(), '.n8n-manager'), 'instance.json');
}

export interface ManagedLocalLifecycleResolution {
  instanceId: string;
  statePath: string;
  containerName: string;
  volumeName: string;
  port: number;
  lifecycle: FileBackedN8nLifecycleManager;
}

export async function createManagedLocalLifecycleManager(
  configuration: N8nConfigurationService,
  input: { instanceId?: string; name?: string; port?: number } & Pick<FileBackedN8nLifecycleManagerOptions, 'runner' | 'fetch' | 'cloudflaredBin' | 'waitForReady'> = {},
): Promise<ManagedLocalLifecycleResolution> {
  const instances = configuration.listInstances();
  const requestedId = cleanIdentifier(input.instanceId);
  const existing = requestedId ? configuration.getInstance(requestedId) : undefined;
  const instanceId = requestedId ?? createUniqueManagedLocalInstanceId(input.name, instances);
  const containerName = readMetadataString(existing?.metadata, 'containerName') ?? instanceId;
  const volumeName = readMetadataString(existing?.metadata, 'volumeName') ?? `${containerName}-data`;
  const statePath = existing?.runtimeStatePath ?? configuration.getRuntimeStatePath(instanceId);
  const port = input.port
    ?? parseLocalPort(existing?.baseUrl)
    ?? await findAvailableManagedPort(instances, instanceId);

  return {
    instanceId,
    statePath,
    containerName,
    volumeName,
    port,
    lifecycle: new FileBackedN8nLifecycleManager(statePath, {
      instanceId,
      containerName,
      volumeName,
      port,
      runner: input.runner,
      fetch: input.fetch,
      cloudflaredBin: input.cloudflaredBin,
      waitForReady: input.waitForReady,
    }),
  };
}

export interface N8nRuntimeOrchestratorOptions extends Pick<FileBackedN8nLifecycleManagerOptions, 'runner' | 'fetch' | 'cloudflaredBin' | 'waitForReady'> {
  configuration?: N8nConfigurationService;
}

export class N8nRuntimeOrchestrator {
  private readonly configuration: N8nConfigurationService;
  private readonly lifecycleOptions: Pick<FileBackedN8nLifecycleManagerOptions, 'runner' | 'fetch' | 'cloudflaredBin' | 'waitForReady'>;

  constructor(options: N8nRuntimeOrchestratorOptions = {}) {
    this.configuration = options.configuration ?? new N8nConfigurationService();
    this.lifecycleOptions = {
      runner: options.runner,
      fetch: options.fetch,
      cloudflaredBin: options.cloudflaredBin,
      waitForReady: options.waitForReady,
    };
  }

  async prepareEffectiveContext(input: {
    workspaceRoot?: string;
    instanceId?: string;
    requireProject?: boolean;
    syncFolderDefault?: import('./configuration-service.js').N8nSyncFolderDefaultPolicy;
    consumer?: N8nRuntimeConsumer;
    autoStart?: boolean;
  } = {}): Promise<PreparedEffectiveN8nContext> {
    let context = this.configuration.resolveEffectiveContext({
      workspaceRoot: input.workspaceRoot,
      instanceId: input.instanceId,
      requireProject: input.requireProject,
      syncFolderDefault: input.syncFolderDefault,
    });
    const diagnostics: PreparedEffectiveN8nContext['diagnostics'] = [];

    if (input.autoStart !== false && context.instance.mode === 'managed-local-docker' && context.instance.desiredState !== 'stopped') {
      try {
        let runtime = await this.getRuntimeStatus(context.instance.id);
        if (!runtime.ready) {
          runtime = await this.startInstance(context.instance.id, { ensurePublicUrl: false });
        }
        diagnostics.push(...diagnosticsFromRuntime(runtime));
        context = this.configuration.resolveEffectiveContext({
          workspaceRoot: input.workspaceRoot,
          instanceId: context.instance.id,
          requireProject: input.requireProject,
          syncFolderDefault: input.syncFolderDefault,
        });
        return { context, runtime, diagnostics };
      } catch (error) {
        const runtime = await this.getRuntimeStatus(context.instance.id, error);
        diagnostics.push(...diagnosticsFromRuntime(runtime));
        return { context, runtime, diagnostics };
      }
    }

    const runtime = await this.getRuntimeStatus(context.instance.id);
    diagnostics.push(...diagnosticsFromRuntime(runtime));
    return { context, runtime, diagnostics };
  }

  async getRuntimeStatus(instanceId: string, observedError?: unknown): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      const hasRuntime = instance.mode !== 'generation-only';
      const apiKey = this.configuration.getApiKey(instance.id);
      return {
        status: hasRuntime ? 'ready' : 'stopped',
        instance: toRuntimePublicInstance(instance, apiKey),
        instanceId: instance.id,
        managed: false,
        ready: hasRuntime ? Boolean(instance.baseUrl && apiKey) : true,
        blocked: hasRuntime && (!instance.baseUrl || !apiKey)
          ? { code: 'api-key-missing', message: `Instance "${instance.name}" needs a host and API key.` }
          : undefined,
        checks: [{
          id: 'instance',
          label: 'n8n instance',
          status: hasRuntime ? 'pass' : 'skip',
          message: hasRuntime ? 'External instance configuration is present.' : 'Runtime disabled by generation-only mode.',
        }],
      };
    }

    if (observedError && isDockerUnavailableError(observedError)) {
      return {
        status: 'unknown',
        instance: toRuntimePublicInstance(instance, this.configuration.getApiKey(instance.id)),
        instanceId: instance.id,
        managed: true,
        ready: false,
        blocked: { code: 'docker-unavailable', message: formatCommandError(observedError) },
        checks: [{ id: 'docker', label: 'Docker', status: 'fail', message: formatCommandError(observedError) }],
        tunnel: tunnelSnapshotFromInstance(instance),
        authBridgeTunnel: authBridgeTunnelSnapshot(),
      };
    }

    const lifecycle = await this.lifecycleForInstance(instance);
    const health = await lifecycle.status();
    const tunnel = await lifecycle.getPublicTunnelStatus();
    const blocked = blockedFromHealth(health, instance);
    const authBridgeTunnel = authBridgeTunnelSnapshot();
    const authBridgeTargetUrl = tunnel.running ? tunnel.publicUrl : undefined;
    const authBridgeOpenUrl = authBridgeTunnel.publicUrl && authBridgeTargetUrl
      ? await getManagedN8nAuthBridgeOpenUrl(instance, authBridgeTargetUrl)
      : undefined;
    return {
      ...health,
      instanceId: instance.id,
      managed: true,
      ready: health.status === 'ready' && !blocked,
      blocked,
      tunnel,
      authBridgeTunnel,
      authBridgeOpenUrl,
    };
  }

  async resolveInstanceAccess(input: ResolveN8nInstanceAccessInput = {}): Promise<N8nInstanceAccessSnapshot> {
    const context = this.configuration.resolveEffectiveContext({
      workspaceRoot: input.workspaceRoot,
      instanceId: input.instanceId,
      syncFolderDefault: input.syncFolderDefault,
    });
    const instance = context.instance;
    const warnings: string[] = [];
    let runtime = await this.getRuntimeStatus(instance.id);

    if (input.mode === 'reconcile' && instance.mode === 'managed-local-docker' && instance.desiredState !== 'stopped') {
      if (!runtime.ready) {
        runtime = await this.startInstance(instance.id, { ensurePublicUrl: false });
      }
      if (instance.publicUrlEnabled) {
        runtime = await this.ensureTunnel(instance.id, { action: input.refreshPublicUrl ? 'refresh' : 'ensure' });
      }
    }

    warnings.push(...(runtime.warnings ?? []));
    if (runtime.tunnel?.lastError) {
      warnings.push(runtime.tunnel.lastError);
    }
    if (runtime.authBridgeTunnel?.lastError) {
      warnings.push(runtime.authBridgeTunnel.lastError);
    }

    const publicN8nUrl = runtime.tunnel?.running ? runtime.tunnel.publicUrl : undefined;
    const authTargetUrl = publicN8nUrl ? buildAccessTargetUrl(publicN8nUrl, input.targetPath) : undefined;
    const authUrl = runtime.authBridgeTunnel?.running && authTargetUrl
      ? await getManagedN8nAuthBridgeOpenUrl(instance, authTargetUrl)
      : undefined;

    return {
      instanceId: instance.id,
      instanceName: instance.name,
      apiBaseUrl: context.apiBaseUrl,
      publicN8nUrl,
      authUrl,
      publicUrlEnabled: Boolean(instance.publicUrlEnabled),
      desiredState: instance.desiredState,
      runtimeStatus: runtime.status,
      ready: runtime.ready,
      blocked: runtime.blocked,
      tunnel: runtime.tunnel,
      authBridge: runtime.authBridgeTunnel,
      warnings: [...new Set(warnings.filter(Boolean))],
    };
  }

  async setupInstance(instanceId: string, input: { tunnel?: boolean; bootstrapOwner?: boolean } = {}): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      return this.getRuntimeStatus(instance.id);
    }
    const lifecycle = await this.lifecycleForInstance(instance);
    const snapshot = await lifecycle.setup({
      mode: 'managed-local-docker',
      tunnel: input.tunnel ?? Boolean(instance.publicUrlEnabled),
      bootstrapOwner: input.bootstrapOwner ?? true,
    });
    await this.syncLifecycleSnapshot(instance, snapshot);
    const warnings = await this.ensureAuthBridgeTunnelIfNeeded(Boolean(snapshot.tunnelPublicUrl));
    const status = await this.getRuntimeStatus(instance.id);
    return warnings.length ? { ...status, warnings } : status;
  }

  async startInstance(instanceId: string, input: { ensurePublicUrl?: boolean } = {}): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      return this.getRuntimeStatus(instance.id);
    }
    this.configuration.upsertInstance({ id: instance.id, desiredState: 'running' }, { setActive: false });
    const lifecycle = await this.lifecycleForInstance(instance);
    const privateState = await readFileBackedN8nInstance(instance.runtimeStatePath);
    const ensurePublicUrl = input.ensurePublicUrl ?? true;
    if (!privateState) {
      return this.setupInstance(instance.id, { tunnel: ensurePublicUrl && Boolean(instance.publicUrlEnabled), bootstrapOwner: true });
    }
    if (ensurePublicUrl && instance.publicUrlEnabled) {
      return this.setupInstance(instance.id, { tunnel: true, bootstrapOwner: true });
    }
    await lifecycle.start();
    await this.syncPrivateRuntimeState(instance);
    return this.getRuntimeStatus(instance.id);
  }

  async stopInstance(instanceId: string): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      return this.getRuntimeStatus(instance.id);
    }
    this.configuration.upsertInstance({ id: instance.id, desiredState: 'stopped' }, { setActive: false });
    const lifecycle = await this.lifecycleForInstance(instance);
    await this.cleanupTunnelWorkers(instance, { disablePublicUrl: false });
    await lifecycle.stop();
    this.configuration.upsertInstance({ id: instance.id, desiredState: 'stopped' }, { setActive: false });
    return this.getRuntimeStatus(instance.id);
  }

  async restartInstance(instanceId: string): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    const hadTunnel = Boolean(instance.publicUrlEnabled);
    if (instance.mode !== 'managed-local-docker') {
      return this.getRuntimeStatus(instance.id);
    }
    this.configuration.upsertInstance({ id: instance.id, desiredState: 'running' }, { setActive: false });
    const lifecycle = await this.lifecycleForInstance(instance);
    await this.cleanupTunnelWorkers(instance, { disablePublicUrl: false });
    await lifecycle.stop();
    return this.setupInstance(instance.id, { tunnel: hadTunnel, bootstrapOwner: true });
  }

  async deleteInstanceRuntime(instanceId: string, input: DeleteN8nInstanceInput = {}): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      return this.getRuntimeStatus(instance.id);
    }
    await this.cleanupTunnelWorkers(instance, { disablePublicUrl: true });
    const lifecycle = await this.lifecycleForInstance(instance);
    const result = await lifecycle.delete(input);
    this.configuration.clearInstanceTunnel(instance.id);
    return {
      ...result,
      instanceId: instance.id,
      managed: true,
      ready: false,
      tunnel: { enabled: false, running: false },
      authBridgeTunnel: authBridgeTunnelSnapshot(),
    };
  }

  async ensureTunnel(instanceId: string, input: { action?: N8nTunnelAction } = {}): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      throw new Error(`Instance "${instance.name}" is not managed by n8n-manager; manage its tunnel outside n8n-manager.`);
    }
    const lifecycle = await this.lifecycleForInstance(instance);
    const privateState = await readFileBackedN8nInstance(instance.runtimeStatePath);
    if (!privateState) {
      await this.setupInstance(instance.id, { tunnel: true, bootstrapOwner: true });
    } else {
      await lifecycle.start();
    }
    const tunnel = await lifecycle.ensurePublicTunnel({ action: input.action ?? 'ensure' });
    await this.syncPrivateRuntimeState(instance);
    const warnings = tunnel.running
      ? await this.ensureAuthBridgeTunnelIfNeeded(true)
      : tunnel.lastError
        ? [`Public URL could not be created: ${tunnel.lastError}`]
        : [];
    const status = await this.getRuntimeStatus(instance.id);
    return warnings.length ? { ...status, warnings } : status;
  }

  async stopTunnel(instanceId: string): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      throw new Error(`Instance "${instance.name}" is not managed by n8n-manager; manage its tunnel outside n8n-manager.`);
    }
    await this.cleanupTunnelWorkers(instance, { disablePublicUrl: true });
    return this.getRuntimeStatus(instance.id);
  }

  async cleanupInstanceProcesses(instanceId: string): Promise<N8nRuntimeStatusSnapshot> {
    const instance = this.requireInstance(instanceId);
    if (instance.mode !== 'managed-local-docker') {
      return this.getRuntimeStatus(instance.id);
    }
    await this.cleanupTunnelWorkers(instance, { disablePublicUrl: false });
    return this.getRuntimeStatus(instance.id);
  }

  private async ensureAuthBridgeTunnelIfNeeded(enabled: boolean): Promise<string[]> {
    if (!enabled) {
      return [];
    }
    try {
      await ensureLocalN8nAuthBridgeRunning({ publicTunnel: true });
      return [];
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      return [`Auto-login URL could not be created. The public n8n URL is available, but it is not auto-authenticated. ${detail}`];
    }
  }

  private async cleanupTunnelWorkers(instance: GlobalN8nInstance, input: { disablePublicUrl: boolean }): Promise<void> {
    await stopLocalN8nAuthBridgePublicTunnel();
    const lifecycle = await this.lifecycleForInstance(instance);
    await lifecycle.stopPublicTunnel({ disable: input.disablePublicUrl });

    if (input.disablePublicUrl) {
      this.configuration.upsertInstance({
        id: instance.id,
        publicUrlEnabled: false,
        tunnelPublicUrl: undefined,
        tunnelTargetUrl: undefined,
        tunnelPid: undefined,
      }, { setActive: false });
    } else {
      this.configuration.clearInstanceTunnel(instance.id);
    }

    await this.syncPrivateRuntimeState(this.configuration.getInstance(instance.id) ?? instance);
  }

  private requireInstance(instanceId: string): GlobalN8nInstance {
    const instance = this.configuration.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Unknown n8n instance: ${instanceId}`);
    }
    return instance;
  }

  private async lifecycleForInstance(instance: GlobalN8nInstance): Promise<FileBackedN8nLifecycleManager> {
    const runtime = await createManagedLocalLifecycleManager(this.configuration, {
      instanceId: instance.id,
      name: instance.name,
      ...this.lifecycleOptions,
    });
    return runtime.lifecycle;
  }

  private async syncLifecycleSnapshot(existing: GlobalN8nInstance, snapshot: N8nInstanceRef): Promise<void> {
    const privateState = await readFileBackedN8nInstance(snapshot.runtimeStatePath);
    const current = this.configuration.getInstance(existing.id) ?? existing;
    this.configuration.upsertInstanceFromLifecycle({
      ...snapshot,
      ...(privateState ?? {}),
      publicUrlEnabled: current.publicUrlEnabled ?? snapshot.publicUrlEnabled ?? privateState?.publicUrlEnabled,
      desiredState: current.desiredState ?? snapshot.desiredState ?? privateState?.desiredState,
      runtimeStatePath: snapshot.runtimeStatePath ?? privateState?.runtimeStatePath ?? existing.runtimeStatePath,
    }, {
      name: current.name,
      apiKey: privateState?.apiKey,
      setActive: false,
    });
  }

  private async syncPrivateRuntimeState(existing: GlobalN8nInstance): Promise<void> {
    const privateState = await readFileBackedN8nInstance(existing.runtimeStatePath);
    if (!privateState) {
      return;
    }
    await this.syncLifecycleSnapshot(existing, privateState);
  }
}

function toRuntimePublicInstance(instance: GlobalN8nInstance, apiKey?: string): N8nInstanceRef {
  const metadata = instance.metadata ?? {};
  const databaseType: 'sqlite' | undefined = metadata.databaseType === 'sqlite' ? 'sqlite' : undefined;
  return stripUndefinedObject({
    id: instance.id,
    mode: instance.mode,
    baseUrl: instance.baseUrl,
    runtimeStatePath: instance.runtimeStatePath,
    apiKeyRef: instance.apiKeyRef,
    provider: instance.provider,
    publicUrlEnabled: instance.publicUrlEnabled,
    desiredState: instance.desiredState,
    tunnelLastAttemptAt: instance.tunnelLastAttemptAt,
    tunnelLastError: instance.tunnelLastError,
    tunnelNextRetryAt: instance.tunnelNextRetryAt,
    containerName: readMetadataString(metadata, 'containerName'),
    volumeName: readMetadataString(metadata, 'volumeName'),
    image: readMetadataString(metadata, 'image'),
    databaseType,
    databasePath: readMetadataString(metadata, 'databasePath'),
    apiKeyAvailable: Boolean(apiKey || instance.apiKeyAvailable),
    tunnelPublicUrl: instance.tunnelPublicUrl,
    tunnelTargetUrl: instance.tunnelTargetUrl,
    tunnelPid: instance.tunnelPid,
  });
}

function tunnelSnapshotFromInstance(instance: GlobalN8nInstance): N8nTunnelSnapshot {
  const enabled = Boolean(instance.publicUrlEnabled || instance.tunnelPublicUrl || instance.tunnelPid);
  const running = Boolean(instance.tunnelPid && isPidAlive(instance.tunnelPid));
  return stripUndefinedObject({
    enabled,
    running,
    publicUrl: instance.tunnelPublicUrl,
    targetUrl: instance.tunnelTargetUrl,
    pid: running ? instance.tunnelPid : undefined,
    lastAttemptAt: instance.tunnelLastAttemptAt,
    lastError: running ? undefined : instance.tunnelLastError,
    nextRetryAt: running ? undefined : instance.tunnelNextRetryAt,
  });
}

function authBridgeTunnelSnapshot(): N8nTunnelSnapshot {
  const status = getLocalN8nAuthBridgeStatus();
  const enabled = Boolean(status.publicUrl || status.tunnelTargetUrl || status.tunnelPid);
  return stripUndefinedObject({
    enabled,
    running: Boolean(status.tunnelRunning),
    publicUrl: status.publicUrl,
    targetUrl: status.tunnelTargetUrl,
    pid: status.tunnelPid,
    lastAttemptAt: status.tunnelLastAttemptAt,
    lastError: status.tunnelRunning ? undefined : status.tunnelLastError,
    nextRetryAt: status.tunnelRunning ? undefined : status.tunnelNextRetryAt,
    startedAt: status.startedAt,
  });
}

function shouldSkipTunnelAttempt(instance: Pick<N8nInstanceRef, 'tunnelLastError' | 'tunnelNextRetryAt'>, action: N8nTunnelAction): boolean {
  if (action === 'refresh') return false;
  if (!instance.tunnelNextRetryAt) return false;
  if (isLegacyWindowsPowerShellTunnelError(instance.tunnelLastError)) return false;
  return Date.parse(instance.tunnelNextRetryAt) > Date.now();
}

function isLegacyWindowsPowerShellTunnelError(error: string | undefined): boolean {
  return Boolean(error?.includes('Start-Process @parameters') && error.includes('FullyQualifiedErrorId : UnexpectedToken'));
}

function buildAccessTargetUrl(baseUrl: string, targetPath?: string): string {
  if (!targetPath) return baseUrl.replace(/\/+$/, '');
  const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return new URL(normalizedPath, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

function blockedFromHealth(
  health: N8nHealthSnapshot,
  instance: GlobalN8nInstance,
): N8nRuntimeStatusSnapshot['blocked'] {
  const dockerFailure = health.checks.find((check) => check.id === 'docker' && check.status === 'fail');
  if (dockerFailure) {
    return { code: 'docker-unavailable', message: dockerFailure.message ?? 'Docker is unavailable.' };
  }

  const containerFailure = health.checks.find((check) => check.id === 'docker-container' && check.status === 'fail');
  if (containerFailure || health.status === 'not-configured') {
    return {
      code: 'runtime-missing',
      message: containerFailure?.message ?? `Managed n8n container for "${instance.name}" does not exist.`,
    };
  }

  if (health.status === 'stopped') {
    if (instance.desiredState === 'stopped') {
      return undefined;
    }
    return {
      code: 'runtime-unhealthy',
      message: `Managed n8n container for "${instance.name}" is stopped.`,
    };
  }

  if (health.status === 'unhealthy' || health.status === 'unknown') {
    return {
      code: 'runtime-unhealthy',
      message: `Managed n8n instance "${instance.name}" is not ready.`,
    };
  }

  const runtimeInstance = health.instance;
  if (!runtimeInstance?.apiKeyAvailable && !instance.apiKeyAvailable) {
    return {
      code: 'api-key-missing',
      message: `Managed n8n instance "${instance.name}" needs an owner API key.`,
    };
  }

  return undefined;
}

function diagnosticsFromRuntime(runtime: N8nRuntimeStatusSnapshot): PreparedEffectiveN8nContext['diagnostics'] {
  if (runtime.blocked) {
    return [{
      code: runtime.blocked.code,
      level: 'error',
      message: runtime.blocked.message,
    }];
  }

  const diagnostics: PreparedEffectiveN8nContext['diagnostics'] = [];
  if (runtime.managed && runtime.ready) {
    diagnostics.push({
      code: 'managed-runtime-ready',
      level: 'info',
      message: 'Managed n8n runtime is ready.',
    });
  }
  if (runtime.tunnel?.enabled) {
    diagnostics.push({
      code: runtime.tunnel.running ? 'tunnel-running' : 'tunnel-stale',
      level: runtime.tunnel.running ? 'info' : 'warning',
      message: runtime.tunnel.running
        ? `Public tunnel is running at ${runtime.tunnel.publicUrl ?? 'the stored URL'}.`
        : 'Public tunnel is configured but not running.',
    });
  }
  return diagnostics;
}

function isDockerUnavailableError(error: unknown): boolean {
  const message = formatCommandError(error).toLowerCase();
  return message.includes('docker is required')
    || message.includes('cannot connect to the docker daemon')
    || message.includes('docker daemon')
    || message.includes('docker: command not found')
    || message.includes('enoent');
}

function createPersonalProjectFallback(): N8nProjectSnapshot {
  return {
    id: 'personal',
    name: 'Personal',
    type: 'personal',
    fallback: true,
  };
}

function stripUndefinedObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function createUniqueManagedLocalInstanceId(name: string | undefined, instances: GlobalN8nInstance[]): string {
  const base = safeDockerName(`n8n-manager-${name?.trim() || 'local'}`);
  const existingIds = new Set(instances.map((instance) => instance.id));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = `${base}-${crypto.randomUUID().slice(0, 8)}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function findAvailableManagedPort(instances: GlobalN8nInstance[], currentInstanceId: string): Promise<number> {
  const usedPorts = new Set(
    instances
      .filter((instance) => instance.id !== currentInstanceId)
      .map((instance) => parseLocalPort(instance.baseUrl))
      .filter((port): port is number => typeof port === 'number'),
  );
  const startPort = Number(process.env.N8N_MANAGER_DOCKER_PORT ?? DEFAULT_PORT);

  return findAvailableHostPort(startPort, usedPorts);
}

async function findAvailableHostPort(startPort: number, usedPorts = new Set<number>()): Promise<number> {
  for (let port = startPort; port < startPort + 200; port += 1) {
    if (usedPorts.has(port)) {
      continue;
    }
    if (await isTcpPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available local port found for managed n8n between ${startPort} and ${startPort + 199}.`);
}

function isDockerPortUnavailableError(error: unknown): boolean {
  const message = formatCommandError(error).toLowerCase();
  return message.includes('ports are not available')
    || message.includes('port is already allocated')
    || message.includes('address already in use')
    || message.includes('/forwards/expose')
    || message.includes('bind for 0.0.0.0');
}

function isTcpPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function parseLocalPort(baseUrl: string | undefined): number | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return undefined;
    }
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  return cleanIdentifier((metadata as Record<string, unknown>)[key]);
}

function cleanIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeDockerName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return normalized || 'n8n-manager-local';
}

function formatCommandError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toPublicInstance(instance: N8nInstanceRef): N8nInstanceRef {
  const { apiKey: _apiKey, ownerPassword: _ownerPassword, ...rest } = instance;
  return {
    ...rest,
    apiKeyAvailable: instance.apiKey ? true : rest.apiKeyAvailable,
    ownerCredentialsAvailable: instance.ownerEmail && instance.ownerPassword ? true : rest.ownerCredentialsAvailable,
  };
}

interface ManagedOwnerCredentials {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

interface ManagedOwnerBootstrap {
  apiKey?: string;
  apiKeyScopes?: string[];
  ownerEmail?: string;
  ownerPassword?: string;
  ownerFirstName?: string;
  ownerLastName?: string;
}

function buildGeneratedOwnerCredentials(baseUrl: string): ManagedOwnerCredentials {
  const suffix = crypto.createHash('sha1').update(`${baseUrl}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 10);
  return {
    email: `n8n-manager-${suffix}@local.invalid`,
    password: `N8nManager${crypto.randomBytes(8).toString('hex').toUpperCase()}1`,
    firstName: 'n8n',
    lastName: 'Manager',
  };
}

function buildApiKeyLabel(attempt: number): string {
  return attempt === 0 ? 'n8n-manager Local Managed' : `n8n-manager Local Managed ${attempt + 1}`;
}

function hasRequiredApiKeyScopes(scopes?: string[]): boolean {
  return DEFAULT_API_KEY_SCOPES.every((scope) => scopes?.includes(scope));
}

function buildUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function extractCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(/,(?=\s*[^;,]+=)/);
  for (const part of parts) {
    const cookie = part.split(';')[0]?.trim();
    if (cookie?.startsWith(`${name}=`)) return cookie;
  }
  return undefined;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function retryBootstrapStep<T>(label: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + DEFAULT_OWNER_BOOTSTRAP_TIMEOUT_MS;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isBootstrapRetryable(lastError)) {
        throw lastError;
      }
      await delay(DEFAULT_RETRY_DELAY_MS);
    }
  }
  throw new Error(`${label} failed: ${lastError?.message ?? 'timeout'}`);
}

function isBootstrapRetryable(error: Error): boolean {
  const message = error.message.toLowerCase();
  if (message.includes('wrong username or password') || message.includes('failed with 401')) {
    return false;
  }
  return message.includes('failed with 404')
    || message.includes('failed with 429')
    || message.includes('failed with 502')
    || message.includes('failed with 503')
    || message.includes('did not return an authenticated n8n session cookie');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number, reason: string): Promise<void> {
  if (pid === process.pid) {
    return;
  }
  recordTunnelTermination(pid, reason, 'SIGTERM');
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await delay(100);
  }
  if (!isPidAlive(pid)) {
    return;
  }
  recordTunnelTermination(pid, reason, 'SIGKILL');
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function recordTunnelTermination(pid: number, reason: string, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    const logPath = path.join(resolveN8nManagerHomeForLogs(), 'logs', 'tunnel-terminations.log');
    fssync.mkdirSync(path.dirname(logPath), { recursive: true });
    fssync.appendFileSync(logPath, JSON.stringify({
      time: new Date().toISOString(),
      pid,
      signal,
      reason,
      stack: new Error().stack,
    }) + '\n');
  } catch {
    // Best-effort diagnostics only.
  }
}

function resolveN8nManagerHomeForLogs(): string {
  const configuredHome = process.env.N8N_MANAGER_HOME?.trim();
  if (configuredHome) return path.resolve(configuredHome);
  const configuredStatePath = process.env.N8N_MANAGER_STATE_PATH?.trim();
  if (configuredStatePath) return path.dirname(path.resolve(configuredStatePath));
  return path.join(os.homedir(), '.n8n-manager');
}

async function installCloudflaredIfNeeded(explicitBin?: string): Promise<string> {
  if (explicitBin) return explicitBin;

  const existing = await findCloudflaredBinary();
  if (existing) return existing;

  const destPath = getLocalCloudflaredBinPath();
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await downloadFile(resolveCloudflaredDownloadUrl(), destPath);
  if (process.platform !== 'win32') {
    await fs.chmod(destPath, 0o755);
  }
  return destPath;
}

async function findCloudflaredBinary(): Promise<string | undefined> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, ['cloudflared'], { encoding: 'utf8' });
    return stdout.trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    // Not in PATH.
  }

  const local = getLocalCloudflaredBinPath();
  return fssync.existsSync(local) ? local : undefined;
}

function getLocalCloudflaredBinPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(os.homedir(), '.n8n-manager', 'bin', `cloudflared${ext}`);
}

function resolveCloudflaredDownloadUrl(): string {
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
    if (process.arch === 'arm') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm';
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  }
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64';
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64';
  }
  if (process.platform === 'win32') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  throw new Error(`Unsupported platform for automatic cloudflared installation: ${process.platform}/${process.arch}.`);
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl: string, depth: number) => {
      if (depth > 10) {
        reject(new Error('Too many redirects downloading cloudflared.'));
        return;
      }

      https.get(currentUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location, depth + 1);
          res.resume();
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Failed to download cloudflared: HTTP ${res.statusCode ?? 'unknown'}`));
          res.resume();
          return;
        }

        const tmpPath = `${destPath}.tmp`;
        const file = fssync.createWriteStream(tmpPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fssync.renameSync(tmpPath, destPath);
          resolve();
        });
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

function waitForTunnelPublicUrl(pid: number, logFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      try {
        const text = fssync.readFileSync(logFile, 'utf8');
        const matches = [...text.matchAll(CLOUDFLARE_URL_PATTERN)];
        const match = matches[matches.length - 1];
        if (match?.[0]) {
          clearInterval(interval);
          resolve(match[0]);
          return;
        }
      } catch {
        // Log file not written yet.
      }

      if (!isPidAlive(pid)) {
        clearInterval(interval);
        reject(new Error(`cloudflared exited before emitting a public URL.${formatCloudflaredLog(logFile)}`));
        return;
      }

      if (Date.now() - startedAt > 30_000) {
        clearInterval(interval);
        reject(new Error(`cloudflared did not emit a public URL within 30s.${formatCloudflaredLog(logFile)}`));
      }
    }, 500);
  });
}


function formatCloudflaredLog(logFile: string): string {
  try {
    const text = fssync.readFileSync(logFile, 'utf8').trim();
    return text ? `\n\ncloudflared log:\n${text.slice(-2000)}` : '';
  } catch {
    return '';
  }
}
