import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fssync from 'node:fs';
import https from 'node:https';
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
  apiKey?: string;
  apiKeyScopes?: string[];
  apiKeyAvailable?: boolean;
  ownerEmail?: string;
  ownerPassword?: string;
  ownerFirstName?: string;
  ownerLastName?: string;
  ownerCredentialsAvailable?: boolean;
  tunnelPublicUrl?: string;
  tunnelPid?: number;
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
const DEFAULT_HEALTH_TIMEOUT_MS = 300_000;
const DEFAULT_EDITOR_TIMEOUT_MS = 90_000;
const DEFAULT_OWNER_BOOTSTRAP_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const CLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
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
  private readonly dockerImage: string;
  private readonly containerName: string;
  private readonly volumeName: string;
  private readonly port: number;
  private readonly bootstrapOwnerDefault: boolean;
  private readonly tunnelDefault: boolean;
  private readonly cloudflaredBin?: string;
  private readonly waitForReady: boolean;

  constructor(
    private readonly statePath = path.join(os.homedir(), '.n8n-manager', 'instance.json'),
    options: FileBackedN8nLifecycleManagerOptions = {},
  ) {
    this.runner = options.runner ?? defaultRunner;
    this.fetcher = options.fetch ?? fetch;
    this.dockerImage = options.dockerImage ?? process.env.N8N_MANAGER_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
    this.containerName = options.containerName ?? process.env.N8N_MANAGER_DOCKER_CONTAINER ?? DEFAULT_CONTAINER_NAME;
    this.volumeName = options.volumeName ?? process.env.N8N_MANAGER_DOCKER_VOLUME ?? DEFAULT_VOLUME_NAME;
    this.port = Number(options.port ?? process.env.N8N_MANAGER_DOCKER_PORT ?? DEFAULT_PORT);
    this.bootstrapOwnerDefault = options.bootstrapOwner ?? process.env.N8N_MANAGER_BOOTSTRAP_OWNER !== 'false';
    this.tunnelDefault = options.tunnel ?? process.env.N8N_MANAGER_TUNNEL === 'true';
    this.cloudflaredBin = options.cloudflaredBin ?? process.env.N8N_MANAGER_CLOUDFLARED_BIN;
    this.waitForReady = options.waitForReady ?? process.env.N8N_MANAGER_WAIT_FOR_READY !== 'false';
  }

  async setup(input: { mode: N8nInstanceMode; baseUrl?: string; apiKeyRef?: string; tunnel?: boolean; bootstrapOwner?: boolean }): Promise<N8nInstanceRef> {
    const existingState = await this.readInstance();
    const shouldTunnel = input.tunnel ?? this.tunnelDefault;
    const shouldBootstrapOwner = input.bootstrapOwner ?? this.bootstrapOwnerDefault;

    if (input.mode === 'managed-local-docker') {
      await this.ensureDockerContainer();
      if (this.waitForReady) {
        await this.waitForN8nReady(`http://127.0.0.1:${this.port}`);
      }
    }

    const baseUrl = input.mode === 'managed-local-docker' ? `http://127.0.0.1:${this.port}` : input.baseUrl;
    const ownerBootstrap = input.mode === 'managed-local-docker' && shouldBootstrapOwner
      ? await this.bootstrapManagedOwner(baseUrl)
      : undefined;
    const tunnel = input.mode === 'managed-local-docker' && shouldTunnel
      ? await this.ensureTunnel(baseUrl)
      : existingState?.tunnelPublicUrl && existingState.tunnelPid
        ? { publicUrl: existingState.tunnelPublicUrl, pid: existingState.tunnelPid }
        : undefined;

    const instance: N8nInstanceRef = {
      id: input.mode === 'managed-local-docker' ? this.containerName : (input.baseUrl ?? input.mode),
      mode: input.mode,
      baseUrl,
      apiKeyRef: ownerBootstrap?.apiKey ? 'managed-local-owner-api-key' : input.apiKeyRef,
      provider: input.mode === 'managed-local-docker'
        ? 'docker'
        : input.mode === 'existing'
          ? 'external'
          : 'none',
      containerName: input.mode === 'managed-local-docker' ? this.containerName : undefined,
      volumeName: input.mode === 'managed-local-docker' ? this.volumeName : undefined,
      image: input.mode === 'managed-local-docker' ? this.dockerImage : undefined,
      apiKey: ownerBootstrap?.apiKey ?? existingState?.apiKey,
      apiKeyScopes: ownerBootstrap?.apiKeyScopes ?? existingState?.apiKeyScopes,
      ownerEmail: ownerBootstrap?.ownerEmail ?? existingState?.ownerEmail,
      ownerPassword: ownerBootstrap?.ownerPassword ?? existingState?.ownerPassword,
      ownerFirstName: ownerBootstrap?.ownerFirstName ?? existingState?.ownerFirstName,
      ownerLastName: ownerBootstrap?.ownerLastName ?? existingState?.ownerLastName,
      tunnelPublicUrl: tunnel?.publicUrl,
      tunnelPid: tunnel?.pid,
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
      await this.stopTunnel(instance);
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
      '-e',
      'N8N_LISTEN_ADDRESS=0.0.0.0',
      '-e',
      'N8N_PROTOCOL=http',
      '-e',
      `N8N_EDITOR_BASE_URL=http://127.0.0.1:${this.port}`,
      '-e',
      'QUEUE_HEALTH_CHECK_ACTIVE=true',
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
    if (existing?.apiKey) {
      return {
        apiKey: existing.apiKey,
        apiKeyScopes: existing.apiKeyScopes,
        ownerEmail: existing.ownerEmail,
        ownerPassword: existing.ownerPassword,
        ownerFirstName: existing.ownerFirstName,
        ownerLastName: existing.ownerLastName,
      };
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
      if (existing?.apiKey) {
        return {
          apiKey: existing.apiKey,
          apiKeyScopes: existing.apiKeyScopes,
          ownerEmail: existing.ownerEmail,
          ownerPassword: existing.ownerPassword,
          ownerFirstName: existing.ownerFirstName,
          ownerLastName: existing.ownerLastName,
        };
      }
      throw new Error(`Managed local n8n is running, but owner/API key bootstrap failed: ${formatCommandError(error)}`);
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
      id: existing?.id ?? this.containerName,
      mode: existing?.mode ?? 'managed-local-docker',
      baseUrl: existing?.baseUrl ?? baseUrl,
      apiKeyRef: existing?.apiKeyRef,
      projectName: existing?.projectName,
      provider: existing?.provider ?? 'docker',
      containerName: existing?.containerName ?? this.containerName,
      volumeName: existing?.volumeName ?? this.volumeName,
      image: existing?.image ?? this.dockerImage,
      apiKey: existing?.apiKey,
      apiKeyScopes: existing?.apiKeyScopes,
      ownerEmail: credentials.email,
      ownerPassword: credentials.password,
      ownerFirstName: credentials.firstName,
      ownerLastName: credentials.lastName,
      tunnelPublicUrl: existing?.tunnelPublicUrl,
      tunnelPid: existing?.tunnelPid,
    });
  }

  private async ensureTunnel(targetUrl?: string): Promise<{ publicUrl: string; pid: number } | undefined> {
    if (!targetUrl) {
      return undefined;
    }

    const bin = await installCloudflaredIfNeeded(this.cloudflaredBin);
    const logFile = path.join(os.tmpdir(), `n8n-manager-cloudflared-${Date.now()}.log`);
    const child = spawn(bin, ['tunnel', '--url', targetUrl, '--no-autoupdate', '--logfile', logFile], {
      detached: true,
      stdio: 'ignore',
    });

    if (!child.pid) {
      throw new Error('cloudflared failed to start.');
    }

    child.unref();
    try {
      const publicUrl = await waitForTunnelPublicUrl(child.pid, logFile);
      return { publicUrl, pid: child.pid };
    } catch (error) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // ignore
      }
      throw error;
    } finally {
      try {
        fssync.unlinkSync(logFile);
      } catch {
        // ignore
      }
    }
  }

  private async stopTunnel(instance: N8nInstanceRef): Promise<void> {
    if (!instance.tunnelPid || !isPidAlive(instance.tunnelPid)) {
      return;
    }
    try {
      process.kill(-instance.tunnelPid, 'SIGTERM');
    } catch {
      try {
        process.kill(instance.tunnelPid, 'SIGTERM');
      } catch {
        // ignore
      }
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

  private async writeInstance(instance: N8nInstanceRef): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(instance, null, 2));
  }
}

export async function readFileBackedN8nInstance(
  statePath = path.join(os.homedir(), '.n8n-manager', 'instance.json'),
): Promise<N8nInstanceRef | undefined> {
  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(content) as N8nInstanceRef;
    return parsed.id && parsed.mode ? parsed : undefined;
  } catch {
    return undefined;
  }
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
      await delay(DEFAULT_RETRY_DELAY_MS);
    }
  }
  throw new Error(`${label} failed: ${lastError?.message ?? 'timeout'}`);
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
        const match = text.match(CLOUDFLARE_URL_PATTERN);
        if (match) {
          clearInterval(interval);
          resolve(match[0]);
          return;
        }
      } catch {
        // Log file not written yet.
      }

      if (!isPidAlive(pid)) {
        clearInterval(interval);
        reject(new Error('cloudflared exited before emitting a public URL.'));
        return;
      }

      if (Date.now() - startedAt > 30_000) {
        clearInterval(interval);
        reject(new Error('cloudflared did not emit a public URL within 30s.'));
      }
    }, 500);
  });
}
