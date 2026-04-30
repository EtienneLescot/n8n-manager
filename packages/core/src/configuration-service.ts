import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type N8nConfigurationInstanceMode = 'managed-local-docker' | 'managed-local-direct' | 'existing' | 'generation-only';
export type N8nDesiredRuntimeState = 'running' | 'stopped';

export interface N8nConfigurationLifecycleInstanceRef {
  id: string;
  mode: N8nConfigurationInstanceMode;
  baseUrl?: string;
  runtimeStatePath?: string;
  provider?: N8nInstanceProvider;
  apiKey?: string;
  apiKeyRef?: string;
  apiKeyAvailable?: boolean;
  publicUrlEnabled?: boolean;
  desiredState?: N8nDesiredRuntimeState;
  containerName?: string;
  volumeName?: string;
  image?: string;
  databaseType?: 'sqlite';
  databasePath?: string;
  tunnelPublicUrl?: string;
  tunnelTargetUrl?: string;
  tunnelPid?: number;
  tunnelLastAttemptAt?: string;
  tunnelLastError?: string;
  tunnelNextRetryAt?: string;
}

export type N8nInstanceProvider = 'docker' | 'external' | 'none';

export type N8nInstanceVerificationStatus = 'unverified' | 'verified' | 'failed';

export interface N8nInstanceVerification {
  status: N8nInstanceVerificationStatus;
  normalizedHost?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface N8nProjectRef {
  id: string;
  name: string;
}

export interface GlobalN8nInstance {
  id: string;
  name: string;
  mode: N8nConfigurationInstanceMode;
  baseUrl?: string;
  provider?: N8nInstanceProvider;
  instanceIdentifier?: string;
  verification?: N8nInstanceVerification;
  defaultProject?: N8nProjectRef;
  runtimeStatePath?: string;
  apiKeyRef?: string;
  apiKeyAvailable?: boolean;
  publicUrlEnabled?: boolean;
  desiredState?: N8nDesiredRuntimeState;
  tunnelPublicUrl?: string;
  tunnelTargetUrl?: string;
  tunnelPid?: number;
  tunnelLastAttemptAt?: string;
  tunnelLastError?: string;
  tunnelNextRetryAt?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface N8nGlobalConfiguration {
  version: 1;
  activeInstanceId?: string;
  defaultSyncFolder: string;
  instances: GlobalN8nInstance[];
}

export interface N8nWorkspaceOverrides {
  version: 3;
  activeInstanceId?: string;
  syncFolder?: string;
  projectId?: string;
  projectName?: string;
  folderSync?: boolean;
  customNodesPath?: string;
}

export type N8nSyncFolderDefaultPolicy = 'global' | 'workspace';

export interface EffectiveN8nContext {
  instance: GlobalN8nInstance;
  activeInstanceId: string;
  activeInstanceName: string;
  /** Technical base URL used for API calls and local proxy targets. */
  apiBaseUrl: string;
  /** Optional public n8n URL. User-facing surfaces should prefer auth bridge URLs over this raw URL. */
  publicBaseUrl?: string;
  /** @deprecated Use apiBaseUrl for API calls. */
  host: string;
  /** @deprecated Use apiBaseUrl for API calls. */
  baseUrl: string;
  apiKey?: string;
  syncFolder: string;
  projectId?: string;
  projectName?: string;
  instanceIdentifier?: string;
  folderSync: boolean;
  customNodesPath?: string;
  sources: {
    instance: 'explicit' | 'workspace' | 'global';
    syncFolder: 'workspace' | 'workspace-default' | 'global';
    project: 'workspace' | 'global' | 'missing';
  };
}

export interface ResolveEffectiveN8nContextInput {
  workspaceRoot?: string;
  instanceId?: string;
  requireProject?: boolean;
  syncFolderDefault?: N8nSyncFolderDefaultPolicy;
}

export interface UpsertGlobalN8nInstanceInput {
  id?: string;
  name?: string;
  mode?: N8nConfigurationInstanceMode;
  baseUrl?: string;
  host?: string;
  apiKey?: string;
  provider?: N8nInstanceProvider;
  publicUrlEnabled?: boolean;
  desiredState?: N8nDesiredRuntimeState;
  instanceIdentifier?: string;
  verification?: N8nInstanceVerification;
  defaultProject?: N8nProjectRef;
  runtimeStatePath?: string;
  apiKeyRef?: string;
  tunnelPublicUrl?: string;
  tunnelTargetUrl?: string;
  tunnelPid?: number;
  tunnelLastAttemptAt?: string;
  tunnelLastError?: string;
  tunnelNextRetryAt?: string;
  metadata?: Record<string, unknown>;
}

export interface N8nConfigurationServiceOptions {
  baseDir?: string;
  instancesPath?: string;
  secretsPath?: string;
  workspaceConfigName?: string;
}

interface SecretStore {
  version: 1;
  instanceApiKeys: Record<string, string>;
}

const DEFAULT_WORKSPACE_CONFIG = 'n8nac-config.json';

export function resolveN8nManagerHome(): string {
  const configuredHome = process.env.N8N_MANAGER_HOME?.trim();
  if (configuredHome) {
    return path.resolve(configuredHome);
  }

  const configuredStatePath = process.env.N8N_MANAGER_STATE_PATH?.trim();
  if (configuredStatePath) {
    return path.dirname(path.resolve(configuredStatePath));
  }

  return path.join(os.homedir(), '.n8n-manager');
}

export function getDefaultN8nManagerSyncFolder(baseDir = resolveN8nManagerHome()): string {
  return path.join(baseDir, 'workflows');
}

export class N8nConfigurationService {
  private readonly baseDir: string;
  private readonly instancesPath: string;
  private readonly secretsPath: string;
  private readonly workspaceConfigName: string;

  constructor(options: N8nConfigurationServiceOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? resolveN8nManagerHome());
    this.instancesPath = path.resolve(options.instancesPath ?? path.join(this.baseDir, 'instances.json'));
    this.secretsPath = path.resolve(options.secretsPath ?? path.join(this.baseDir, 'secrets.json'));
    this.workspaceConfigName = options.workspaceConfigName ?? DEFAULT_WORKSPACE_CONFIG;
  }

  getGlobalConfig(): N8nGlobalConfiguration {
    return this.readGlobalConfig();
  }

  listInstances(): GlobalN8nInstance[] {
    return this.readGlobalConfig().instances;
  }

  getInstance(instanceId: string): GlobalN8nInstance | undefined {
    return this.listInstances().find((instance) => instance.id === instanceId);
  }

  getGlobalActiveInstance(): GlobalN8nInstance | undefined {
    const config = this.readGlobalConfig();
    return config.activeInstanceId
      ? config.instances.find((instance) => instance.id === config.activeInstanceId)
      : undefined;
  }

  upsertInstance(input: UpsertGlobalN8nInstanceInput, options: { setActive?: boolean } = {}): GlobalN8nInstance {
    const config = this.readGlobalConfig();
    const existing = input.id ? config.instances.find((instance) => instance.id === input.id) : undefined;
    const now = new Date().toISOString();
    const baseUrl = cleanString(input.baseUrl ?? input.host ?? existing?.baseUrl);
    const id = cleanString(input.id ?? existing?.id) ?? createInstanceId(baseUrl ?? input.name);

    const hasTunnelPublicUrlInput = Object.prototype.hasOwnProperty.call(input, 'tunnelPublicUrl');
    const hasTunnelTargetUrlInput = Object.prototype.hasOwnProperty.call(input, 'tunnelTargetUrl');
    const hasTunnelPidInput = Object.prototype.hasOwnProperty.call(input, 'tunnelPid');
    const hasTunnelErrorInput = Object.prototype.hasOwnProperty.call(input, 'tunnelLastError');

    const mode = input.mode ?? existing?.mode ?? 'existing';

    const instance: GlobalN8nInstance = {
      id,
      name: cleanString(input.name ?? existing?.name) ?? createDefaultInstanceName(baseUrl),
      mode,
      baseUrl,
      provider: input.provider ?? existing?.provider ?? providerForMode(mode),
      instanceIdentifier: cleanString(input.instanceIdentifier ?? existing?.instanceIdentifier),
      verification: input.verification ?? existing?.verification,
      defaultProject: input.defaultProject ?? existing?.defaultProject,
      runtimeStatePath: cleanString(input.runtimeStatePath ?? existing?.runtimeStatePath),
      apiKeyRef: input.apiKey || existing?.apiKeyAvailable ? `n8n-manager:instance:${id}` : existing?.apiKeyRef,
      apiKeyAvailable: Boolean(input.apiKey) || Boolean(existing?.apiKeyAvailable),
      publicUrlEnabled: input.publicUrlEnabled ?? existing?.publicUrlEnabled ?? false,
      desiredState: input.desiredState ?? existing?.desiredState ?? (mode === 'managed-local-docker' ? 'running' : undefined),
      tunnelPublicUrl: cleanString(hasTunnelPublicUrlInput ? input.tunnelPublicUrl : existing?.tunnelPublicUrl),
      tunnelTargetUrl: cleanString(hasTunnelTargetUrlInput ? input.tunnelTargetUrl : existing?.tunnelTargetUrl),
      tunnelPid: hasTunnelPidInput ? (typeof input.tunnelPid === 'number' ? input.tunnelPid : undefined) : existing?.tunnelPid,
      tunnelLastAttemptAt: cleanString(input.tunnelLastAttemptAt ?? existing?.tunnelLastAttemptAt),
      tunnelLastError: cleanString(hasTunnelErrorInput ? input.tunnelLastError : existing?.tunnelLastError),
      tunnelNextRetryAt: cleanString(input.tunnelNextRetryAt ?? existing?.tunnelNextRetryAt),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: input.metadata ?? existing?.metadata,
    };

    const instances: GlobalN8nInstance[] = [
      ...config.instances.filter((candidate) => candidate.id !== id),
      stripUndefined(instance),
    ].sort((left, right) => left.name.localeCompare(right.name));

    const next: N8nGlobalConfiguration = {
      ...config,
      activeInstanceId: options.setActive === false ? (config.activeInstanceId ?? id) : id,
      instances,
    };
    this.writeGlobalConfig(next);

    if (input.apiKey) {
      this.saveApiKey(id, input.apiKey);
    }

    return stripUndefined(instance);
  }

  upsertInstanceFromLifecycle(instance: N8nConfigurationLifecycleInstanceRef, options: { name?: string; apiKey?: string; setActive?: boolean } = {}): GlobalN8nInstance {
    return this.upsertInstance({
      id: instance.id,
      name: options.name,
      mode: instance.mode,
      baseUrl: instance.baseUrl,
      provider: instance.provider,
      runtimeStatePath: instance.runtimeStatePath ?? (instance.mode === 'managed-local-docker' ? this.getRuntimeStatePath(instance.id) : undefined),
      apiKey: options.apiKey ?? instance.apiKey,
      apiKeyRef: instance.apiKeyRef,
      publicUrlEnabled: instance.publicUrlEnabled,
      desiredState: instance.desiredState,
      tunnelPublicUrl: instance.tunnelPublicUrl,
      tunnelTargetUrl: instance.tunnelTargetUrl,
      tunnelPid: instance.tunnelPid,
      tunnelLastAttemptAt: instance.tunnelLastAttemptAt,
      tunnelLastError: instance.tunnelLastError,
      tunnelNextRetryAt: instance.tunnelNextRetryAt,
      metadata: stripUndefined({
        containerName: instance.containerName,
        volumeName: instance.volumeName,
        image: instance.image,
        databaseType: instance.databaseType,
        databasePath: instance.databasePath,
      }),
    }, { setActive: options.setActive });
  }

  deleteInstance(instanceId: string): { deletedInstance: GlobalN8nInstance; activeInstance?: GlobalN8nInstance } {
    const config = this.readGlobalConfig();
    const deletedInstance = config.instances.find((instance) => instance.id === instanceId);
    if (!deletedInstance) {
      throw new Error(`Unknown n8n instance: ${instanceId}`);
    }

    const instances = config.instances.filter((instance) => instance.id !== instanceId);
    const activeInstanceId = config.activeInstanceId === instanceId ? instances[0]?.id : config.activeInstanceId;
    this.writeGlobalConfig({ ...config, instances, activeInstanceId });
    this.deleteApiKey(instanceId);
    return {
      deletedInstance,
      activeInstance: activeInstanceId ? instances.find((instance) => instance.id === activeInstanceId) : undefined,
    };
  }

  setGlobalActiveInstance(instanceId: string): GlobalN8nInstance {
    const config = this.readGlobalConfig();
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      throw new Error(`Unknown n8n instance: ${instanceId}`);
    }
    this.writeGlobalConfig({ ...config, activeInstanceId: instance.id });
    return instance;
  }

  setDefaultSyncFolder(syncFolder: string): N8nGlobalConfiguration {
    const config = this.readGlobalConfig();
    const defaultSyncFolder = path.resolve(syncFolder);
    const next = { ...config, defaultSyncFolder };
    this.writeGlobalConfig(next);
    return next;
  }

  setInstanceDefaultProject(instanceId: string, project: N8nProjectRef): GlobalN8nInstance {
    const instance = this.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Unknown n8n instance: ${instanceId}`);
    }
    return this.upsertInstance({ ...instance, defaultProject: project }, { setActive: false });
  }

  clearInstanceTunnel(instanceId: string): GlobalN8nInstance {
    const config = this.readGlobalConfig();
    const instance = config.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) {
      throw new Error(`Unknown n8n instance: ${instanceId}`);
    }

    const nextInstance = stripUndefined({
      ...instance,
      tunnelPublicUrl: undefined,
      tunnelTargetUrl: undefined,
      tunnelPid: undefined,
      tunnelLastAttemptAt: undefined,
      tunnelLastError: undefined,
      tunnelNextRetryAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    const instances = config.instances.map((candidate) => candidate.id === instanceId ? nextInstance : candidate);
    this.writeGlobalConfig({ ...config, instances });
    return nextInstance;
  }

  readWorkspaceOverrides(workspaceRoot: string): N8nWorkspaceOverrides {
    const configPath = this.getWorkspaceConfigPath(workspaceRoot);
    if (!fs.existsSync(configPath)) {
      return { version: 3 };
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    return normalizeWorkspaceOverrides(parsed, configPath);
  }

  writeWorkspaceOverrides(workspaceRoot: string, overrides: Partial<N8nWorkspaceOverrides>): N8nWorkspaceOverrides {
    const configPath = this.getWorkspaceConfigPath(workspaceRoot);
    const next = sanitizeWorkspaceOverrides({ version: 3, ...overrides });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  clearWorkspaceOverrides(workspaceRoot: string): void {
    fs.rmSync(this.getWorkspaceConfigPath(workspaceRoot), { force: true });
  }

  resolveEffectiveContext(input: ResolveEffectiveN8nContextInput = {}): EffectiveN8nContext {
    const globalConfig = this.readGlobalConfig();
    const workspace = input.workspaceRoot ? this.readWorkspaceOverrides(input.workspaceRoot) : { version: 3 } satisfies N8nWorkspaceOverrides;
    const requestedInstanceId = cleanString(input.instanceId);
    const workspaceInstanceId = cleanString(workspace.activeInstanceId);
    const globalInstanceId = cleanString(globalConfig.activeInstanceId);
    const activeInstanceId = requestedInstanceId ?? workspaceInstanceId ?? globalInstanceId;

    if (!activeInstanceId) {
      throw new Error('No active n8n instance is configured. Run `n8n-manager instances add` first.');
    }

    const instance = globalConfig.instances.find((candidate) => candidate.id === activeInstanceId);
    if (!instance) {
      throw new Error(`Active n8n instance "${activeInstanceId}" does not exist in the global n8n-manager store.`);
    }

    const apiBaseUrl = resolveInstanceApiBaseUrl(instance);
    if (!apiBaseUrl) {
      throw new Error(`n8n instance "${instance.name}" has no base URL configured.`);
    }
    const publicBaseUrl = resolveInstancePublicBaseUrl(instance);

    const workspaceSyncFolder = cleanString(workspace.syncFolder);
    const syncFolderDefault = input.syncFolderDefault ?? 'global';
    const syncFolder = workspaceSyncFolder
      ? input.workspaceRoot
        ? resolveWorkspacePath(input.workspaceRoot, workspaceSyncFolder)
        : workspaceSyncFolder
      : syncFolderDefault === 'workspace' && input.workspaceRoot
        ? path.join(input.workspaceRoot, 'workflows')
        : globalConfig.defaultSyncFolder;

    const projectId = cleanString(workspace.projectId) ?? instance.defaultProject?.id;
    const projectName = cleanString(workspace.projectName) ?? instance.defaultProject?.name;
    if (input.requireProject && (!projectId || !projectName)) {
      throw new Error(`No n8n project is configured for instance "${instance.name}". Select a project for this workspace or set an instance default project.`);
    }

    return {
      instance,
      activeInstanceId: instance.id,
      activeInstanceName: instance.name,
      apiBaseUrl,
      publicBaseUrl,
      host: apiBaseUrl,
      baseUrl: apiBaseUrl,
      apiKey: this.getApiKey(instance.id),
      syncFolder,
      projectId,
      projectName,
      instanceIdentifier: instance.instanceIdentifier,
      folderSync: workspace.folderSync ?? false,
      customNodesPath: workspace.customNodesPath,
      sources: {
        instance: requestedInstanceId ? 'explicit' : workspaceInstanceId ? 'workspace' : 'global',
        syncFolder: workspaceSyncFolder ? 'workspace' : syncFolderDefault === 'workspace' && input.workspaceRoot ? 'workspace-default' : 'global',
        project: workspace.projectId || workspace.projectName ? 'workspace' : instance.defaultProject ? 'global' : 'missing',
      },
    };
  }

  getApiKey(instanceId: string): string | undefined {
    return this.readSecrets().instanceApiKeys[instanceId];
  }

  saveApiKey(instanceId: string, apiKey: string): void {
    const secrets = this.readSecrets();
    secrets.instanceApiKeys[instanceId] = apiKey;
    this.writeSecrets(secrets);
  }

  deleteApiKey(instanceId: string): void {
    const secrets = this.readSecrets();
    if (!(instanceId in secrets.instanceApiKeys)) {
      return;
    }
    delete secrets.instanceApiKeys[instanceId];
    this.writeSecrets(secrets);
  }

  getWorkspaceConfigPath(workspaceRoot: string): string {
    return path.join(path.resolve(workspaceRoot), this.workspaceConfigName);
  }

  getRuntimeStatePath(instanceId: string): string {
    return path.join(this.baseDir, 'runtime', `${safeFileName(instanceId)}.json`);
  }

  private readGlobalConfig(): N8nGlobalConfiguration {
    if (!fs.existsSync(this.instancesPath)) {
      return {
        version: 1,
        defaultSyncFolder: getDefaultN8nManagerSyncFolder(this.baseDir),
        instances: [],
      };
    }

    const parsed = JSON.parse(fs.readFileSync(this.instancesPath, 'utf8')) as Partial<N8nGlobalConfiguration>;
    const instances = Array.isArray(parsed.instances)
      ? parsed.instances.map(sanitizeInstance)
      : [];
    const activeInstanceId = typeof parsed.activeInstanceId === 'string' && instances.some((instance) => instance.id === parsed.activeInstanceId)
      ? parsed.activeInstanceId
      : instances[0]?.id;

    return {
      version: 1,
      activeInstanceId,
      defaultSyncFolder: cleanString(parsed.defaultSyncFolder) ?? getDefaultN8nManagerSyncFolder(this.baseDir),
      instances,
    };
  }

  private writeGlobalConfig(config: N8nGlobalConfiguration): void {
    fs.mkdirSync(path.dirname(this.instancesPath), { recursive: true });
    fs.writeFileSync(this.instancesPath, `${JSON.stringify(stripUndefined(config), null, 2)}\n`);
  }

  private readSecrets(): SecretStore {
    if (!fs.existsSync(this.secretsPath)) {
      return { version: 1, instanceApiKeys: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(this.secretsPath, 'utf8')) as Partial<SecretStore>;
    return {
      version: 1,
      instanceApiKeys: parsed.instanceApiKeys && typeof parsed.instanceApiKeys === 'object'
        ? Object.fromEntries(Object.entries(parsed.instanceApiKeys).filter(([, value]) => typeof value === 'string'))
        : {},
    };
  }

  private writeSecrets(secrets: SecretStore): void {
    fs.mkdirSync(path.dirname(this.secretsPath), { recursive: true });
    fs.writeFileSync(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.secretsPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
  }
}

function normalizeWorkspaceOverrides(raw: unknown, configPath: string): N8nWorkspaceOverrides {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid n8n workspace config at ${configPath}. Recreate it with the version 3 workspace override format.`);
  }
  const source = raw as Record<string, unknown>;
  if (Array.isArray(source.instances) || source.version !== 3) {
    throw new Error(`Unsupported legacy n8n workspace config at ${configPath}. Reconfigure this workspace with the version 3 override format.`);
  }
  return sanitizeWorkspaceOverrides(source);
}

function sanitizeWorkspaceOverrides(source: Partial<N8nWorkspaceOverrides> | Record<string, unknown>): N8nWorkspaceOverrides {
  return stripUndefined({
    version: 3 as const,
    activeInstanceId: cleanString(source.activeInstanceId),
    syncFolder: cleanString(source.syncFolder),
    projectId: cleanString(source.projectId),
    projectName: cleanString(source.projectName),
    folderSync: typeof source.folderSync === 'boolean' ? source.folderSync : undefined,
    customNodesPath: cleanString(source.customNodesPath),
  });
}

function sanitizeInstance(source: GlobalN8nInstance): GlobalN8nInstance {
  const id = cleanString(source.id) ?? createInstanceId(source.baseUrl ?? source.name);
  return stripUndefined({
    id,
    name: cleanString(source.name) ?? createDefaultInstanceName(source.baseUrl),
    mode: source.mode ?? 'existing',
    baseUrl: cleanString(source.baseUrl),
    provider: source.provider ?? providerForMode(source.mode ?? 'existing'),
    instanceIdentifier: cleanString(source.instanceIdentifier),
    verification: source.verification,
    defaultProject: source.defaultProject?.id && source.defaultProject.name
      ? { id: source.defaultProject.id, name: source.defaultProject.name }
      : undefined,
    runtimeStatePath: cleanString(source.runtimeStatePath),
    apiKeyRef: cleanString(source.apiKeyRef),
    apiKeyAvailable: Boolean(source.apiKeyAvailable),
    publicUrlEnabled: typeof source.publicUrlEnabled === 'boolean' ? source.publicUrlEnabled : undefined,
    desiredState: source.desiredState === 'stopped' ? 'stopped' : source.mode === 'managed-local-docker' ? 'running' : undefined,
    tunnelPublicUrl: cleanString(source.tunnelPublicUrl ?? readMetadataString(source.metadata, 'tunnelPublicUrl')),
    tunnelTargetUrl: cleanString(source.tunnelTargetUrl ?? readMetadataString(source.metadata, 'tunnelTargetUrl')),
    tunnelPid: typeof source.tunnelPid === 'number'
      ? source.tunnelPid
      : readMetadataNumber(source.metadata, 'tunnelPid'),
    tunnelLastAttemptAt: cleanString(source.tunnelLastAttemptAt),
    tunnelLastError: cleanString(source.tunnelLastError),
    tunnelNextRetryAt: cleanString(source.tunnelNextRetryAt),
    createdAt: cleanString(source.createdAt),
    updatedAt: cleanString(source.updatedAt),
    metadata: source.metadata,
  });
}

function providerForMode(mode: N8nConfigurationInstanceMode): N8nInstanceProvider {
  if (mode === 'managed-local-docker') return 'docker';
  if (mode === 'existing') return 'external';
  return 'none';
}

function createInstanceId(seed?: string): string {
  const prefix = seed ? safeFileName(seed).slice(0, 32) : 'instance';
  return `${prefix || 'instance'}-${crypto.randomUUID().slice(0, 8)}`;
}

function createDefaultInstanceName(baseUrl?: string): string {
  if (!baseUrl) {
    return 'n8n instance';
  }
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveWorkspacePath(workspaceRoot: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath);
}

function resolveInstanceApiBaseUrl(instance: GlobalN8nInstance): string | undefined {
  return cleanString(instance.baseUrl) ?? cleanString(instance.tunnelPublicUrl);
}

function resolveInstancePublicBaseUrl(instance: GlobalN8nInstance): string | undefined {
  return cleanString(instance.tunnelPublicUrl);
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  return cleanString((metadata as Record<string, unknown>)[key]);
}

function readMetadataNumber(metadata: unknown, key: string): number | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function safeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance';
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
