#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  FileBackedN8nLifecycleManager,
  N8nConfigurationService,
  N8nRuntimeOrchestrator,
  createManagedLocalLifecycleManager,
  ensureLocalN8nAuthBridgeRunning,
  getN8nManagerAgentInstructions,
  getLocalN8nAuthBridgeStatus,
  listN8nProjects,
  presentWorkflowResult,
  readFileBackedN8nInstance,
  testN8nApiConnection,
  type GlobalN8nInstance,
  type N8nInstanceMode,
  type N8nProjectSnapshot,
  type N8nTunnelAction,
} from '@n8n-as-code/n8n-manager-core';
import {
  N8nCredentialsManager,
  N8nRestCredentialClient,
  listStarterKits,
  type CredentialInventoryItem,
} from '@n8n-as-code/n8n-credentials-manager';

async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim().replace(/^['"]|['"]$/g, '');
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, subcommand, value] = argv;
  const config = new N8nConfigurationService();
  const runtime = new N8nRuntimeOrchestrator({ configuration: config });
  const lifecycle = new FileBackedN8nLifecycleManager(process.env.N8N_MANAGER_STATE_PATH);

  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      printHelp();
      return 0;
    }

    if (command === 'setup') {
      const mode = parseMode(readFlag(argv, '--mode') ?? 'generation-only');
      const baseUrl = readFlag(argv, '--url');
      const runtime = mode === 'managed-local-docker'
        ? await createManagedLocalLifecycleManager(config, {
          instanceId: readFlag(argv, '--id'),
          name: readFlag(argv, '--name'),
        })
        : undefined;
      const selectedLifecycle = runtime?.lifecycle ?? lifecycle;
      const selectedStatePath = runtime?.statePath ?? process.env.N8N_MANAGER_STATE_PATH;
      const snapshot = await selectedLifecycle.setup({
        mode,
        baseUrl,
        tunnel: argv.includes('--tunnel'),
        bootstrapOwner: !argv.includes('--no-bootstrap-owner'),
      });
      const privateSnapshot = await readFileBackedN8nInstance(selectedStatePath);
      const stored = config.upsertInstanceFromLifecycle(snapshot, {
        name: readFlag(argv, '--name'),
        apiKey: readFlag(argv, '--api-key') ?? privateSnapshot?.apiKey,
        setActive: true,
      });
      printJson({
        operation: 'setup',
        storedInstance: stored,
        instance: snapshot,
        next: mode === 'managed-local-docker'
          ? snapshot.apiKeyAvailable
            ? `Open ${snapshot.tunnelPublicUrl ?? snapshot.baseUrl ?? 'the local n8n URL'}. Managed owner API key is ready.`
            : `Open ${snapshot.baseUrl ?? 'the local n8n URL'} and finish first-run setup if n8n asks for an owner account.`
          : 'Run `n8n-manager credentials starter-kit ai-workflows`.',
      });
      return 0;
    }

    if (command === 'status') {
      const selected = resolveInstance(config, readFlag(argv, '--instance'), { required: true });
      if (!selected) throw new Error('No active n8n instance is configured.');
      printJson(await runtime.getRuntimeStatus(selected.id));
      return 0;
    }

    if (command === 'start') {
      const selected = resolveInstance(config, readFlag(argv, '--instance'), { required: true });
      if (!selected) throw new Error('No active n8n instance is configured.');
      printJson(await runtime.startInstance(selected.id));
      return 0;
    }

    if (command === 'stop') {
      const selected = resolveInstance(config, readFlag(argv, '--instance'), { required: true });
      if (!selected) throw new Error('No active n8n instance is configured.');
      printJson(await runtime.stopInstance(selected.id));
      return 0;
    }

    if (command === 'restart') {
      const selected = resolveInstance(config, readFlag(argv, '--instance'), { required: true });
      if (!selected) throw new Error('No active n8n instance is configured.');
      printJson(await runtime.restartInstance(selected.id));
      return 0;
    }

    if (command === 'delete') {
      const destroyData = argv.includes('--destroy-data');
      const force = argv.includes('--force');
      if (destroyData && !force) {
        throw new Error('Refusing to destroy n8n data without --force.');
      }
      const selected = resolveInstance(config, readFlag(argv, '--instance'), { required: true });
      if (!selected) throw new Error('No active n8n instance is configured.');
      printJson(await runtime.deleteInstanceRuntime(selected.id, { destroyData, force }));
      return 0;
    }

    if (command === 'instances') {
      if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        printInstancesHelp();
        return 0;
      }

      if (subcommand === 'list' || !subcommand) {
        printJson(config.getGlobalConfig());
        return 0;
      }

      if (subcommand === 'add') {
        const baseUrl = readFlag(argv, '--url');
        const apiKey = argv.includes('--api-key-stdin')
          ? await readSecretFromStdin()
          : readFlag(argv, '--api-key');
        const mode = parseMode(readFlag(argv, '--mode') ?? 'existing');
        if (mode === 'managed-local-docker') {
          const runtime = await createManagedLocalLifecycleManager(config, {
            instanceId: readFlag(argv, '--id'),
            name: readFlag(argv, '--name'),
          });
          const snapshot = await runtime.lifecycle.setup({
            mode,
            tunnel: argv.includes('--tunnel'),
            bootstrapOwner: !argv.includes('--no-bootstrap-owner'),
          });
          const privateSnapshot = await readFileBackedN8nInstance(runtime.statePath);
          const instance = config.upsertInstanceFromLifecycle(snapshot, {
            name: readFlag(argv, '--name'),
            apiKey: privateSnapshot?.apiKey,
            setActive: !argv.includes('--no-select'),
          });
          printJson({ operation: 'instances.add', instance });
          return 0;
        }
        const instance = config.upsertInstance({
          id: readFlag(argv, '--id'),
          name: readFlag(argv, '--name'),
          mode,
          baseUrl,
          apiKey,
        }, { setActive: !argv.includes('--no-select') });
        printJson({ operation: 'instances.add', instance });
        return 0;
      }

      if (subcommand === 'select') {
        if (!value) throw new Error('Missing instance id or name. Example: n8n-manager instances select production');
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        printJson({ operation: 'instances.select', instance: config.setGlobalActiveInstance(instance.id) });
        return 0;
      }

      if (subcommand === 'status') {
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        printJson(await runtime.getRuntimeStatus(instance.id));
        return 0;
      }

      if (subcommand === 'setup') {
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        printJson(await runtime.setupInstance(instance.id, {
          tunnel: argv.includes('--tunnel') || Boolean(instance.tunnelPublicUrl || instance.tunnelTargetUrl),
          bootstrapOwner: !argv.includes('--no-bootstrap-owner'),
        }));
        return 0;
      }

      if (subcommand === 'start') {
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        printJson(await runtime.startInstance(instance.id));
        return 0;
      }

      if (subcommand === 'stop') {
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        printJson(await runtime.stopInstance(instance.id));
        return 0;
      }

      if (subcommand === 'restart') {
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        printJson(await runtime.restartInstance(instance.id));
        return 0;
      }

      if (subcommand === 'tunnel') {
        const tunnelCommand = value;
        const selector = argv[3];
        if (!tunnelCommand) throw new Error('Missing tunnel command. Example: n8n-manager instances tunnel status local');
        const instance = resolveInstance(config, selector, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${selector}`);
        if (tunnelCommand === 'status') {
          printJson((await runtime.getRuntimeStatus(instance.id)).tunnel ?? { enabled: false, running: false });
          return 0;
        }
        if (tunnelCommand === 'url') {
          const status = await runtime.getRuntimeStatus(instance.id);
          printJson({ url: status.tunnel?.publicUrl ?? null, running: status.tunnel?.running ?? false });
          return 0;
        }
        if (tunnelCommand === 'stop') {
          printJson(await runtime.stopTunnel(instance.id));
          return 0;
        }
        if (tunnelCommand === 'start' || tunnelCommand === 'ensure' || tunnelCommand === 'refresh') {
          printJson(await runtime.ensureTunnel(instance.id, { action: tunnelCommand as N8nTunnelAction }));
          return 0;
        }
        throw new Error(`Unknown tunnel command: ${tunnelCommand}`);
      }

      if (subcommand === 'delete') {
        if (!value) throw new Error('Missing instance id or name. Example: n8n-manager instances delete production');
        const destroyData = argv.includes('--destroy-data');
        const force = argv.includes('--force');
        if (destroyData && !force) {
          throw new Error('Refusing to destroy n8n data without --force.');
        }
        const instance = resolveInstance(config, value, { required: true });
        if (!instance) throw new Error(`Unknown n8n instance: ${value}`);
        if (destroyData && instance.runtimeStatePath) {
          await runtime.deleteInstanceRuntime(instance.id, { destroyData, force });
        } else if (instance.mode === 'managed-local-docker') {
          await runtime.cleanupInstanceProcesses(instance.id);
        }
        printJson({ operation: 'instances.delete', result: config.deleteInstance(instance.id) });
        return 0;
      }
    }

    if (command === 'config') {
      if (subcommand === 'get' || !subcommand) {
        printJson(config.getGlobalConfig());
        return 0;
      }

      if (subcommand === 'set-sync-folder') {
        if (!value) throw new Error('Missing sync folder. Example: n8n-manager config set-sync-folder ~/.n8n-manager/workflows');
        printJson(config.setDefaultSyncFolder(value));
        return 0;
      }
    }

    if (command === 'auth') {
      if (subcommand === 'set') {
        const baseUrl = readFlag(argv, '--url');
        const apiKey = readFlag(argv, '--api-key') ?? (argv.includes('--api-key-stdin') ? await readSecretFromStdin() : undefined);
        if (!baseUrl) throw new Error('Missing n8n URL. Example: n8n-manager auth set --url http://localhost:5678 --api-key KEY');
        if (!apiKey) throw new Error('Missing n8n API key. Example: n8n-manager auth set --url http://localhost:5678 --api-key-stdin');
        await testN8nApiConnection({ baseUrl, apiKey });
        const instance = config.upsertInstance({
          id: readFlag(argv, '--id'),
          name: readFlag(argv, '--name'),
          mode: 'existing',
          baseUrl,
          apiKey,
        }, { setActive: !argv.includes('--no-select') });
        printJson({ operation: 'auth.set', instance });
        return 0;
      }

      if (subcommand === 'test' || !subcommand) {
        const selected = resolveInstance(config, readFlag(argv, '--instance'));
        const context = selected
          ? config.resolveEffectiveContext({ instanceId: selected.id })
          : config.resolveEffectiveContext();
        const baseUrl = readFlag(argv, '--url') ?? context.host;
        const apiKey = readFlag(argv, '--api-key') ?? context.apiKey;
        if (!baseUrl || !apiKey) throw new Error('Missing n8n URL or API key.');
        await testN8nApiConnection({ baseUrl, apiKey });
        printJson({ operation: 'auth.test', ok: true, instanceId: context.activeInstanceId, host: baseUrl });
        return 0;
      }
    }

    if (command === 'projects') {
      const selected = resolveInstance(config, readFlag(argv, '--instance'));
      const context = selected
        ? config.resolveEffectiveContext({ instanceId: selected.id })
        : config.resolveEffectiveContext();
      if (!context.host || !context.apiKey) {
        throw new Error(`Instance "${context.activeInstanceName}" needs a host and API key before projects can be loaded.`);
      }
      const projects = await listN8nProjects({ baseUrl: context.host, apiKey: context.apiKey });

      if (subcommand === 'list' || !subcommand) {
        printJson({ operation: 'projects.list', instanceId: context.activeInstanceId, projects });
        return 0;
      }

      if (subcommand === 'select') {
        if (!value) throw new Error('Missing project id or name. Example: n8n-manager projects select personal');
        const project = resolveProject(projects, value);
        if (!project) throw new Error(`Unknown n8n project: ${value}`);
        const instance = config.setInstanceDefaultProject(context.activeInstanceId, {
          id: project.id,
          name: displayProjectName(project),
        });
        printJson({ operation: 'projects.select', instance, project: instance.defaultProject });
        return 0;
      }
    }

    if (command === 'agent') {
      if (subcommand === 'instructions' || subcommand === 'context' || !subcommand) {
        const content = getN8nManagerAgentInstructions({
          command: readFlag(argv, '--command') ?? 'n8n-manager',
          workspaceRoot: readFlag(argv, '--workspace-root') ?? inferWorkspaceRootFromCwd(),
        });
        const outputPath = readFlag(argv, '--write');
        if (outputPath) {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${content}\n`);
        } else {
          process.stdout.write(`${content}\n`);
        }
        return 0;
      }
    }

    if (command === 'presentWorkflowResult' || command === 'present-workflow-result') {
      const workflowId = readFlag(argv, '--workflow-id') ?? value;
      if (!workflowId) throw new Error('Missing workflow id. Example: n8n-manager presentWorkflowResult --workflow-id abc123');
      const selected = readFlag(argv, '--instance')
        ? resolveInstance(config, readFlag(argv, '--instance'), { required: true })
        : undefined;
      const workspaceRoot = readFlag(argv, '--workspace-root') ?? inferWorkspaceRootFromCwd();
      const workflowUrl = readFlag(argv, '--workflow-url');
      const access = await runtime.resolveInstanceAccess({
        workspaceRoot,
        instanceId: selected?.id,
        syncFolderDefault: workspaceRoot ? 'workspace' : 'global',
        consumer: 'agent',
        mode: 'reconcile',
        targetPath: workflowAccessTargetPath(workflowId, workflowUrl),
      });
      if (access.authUrl) {
        printJson({
          __type: 'workflow-embed',
          kind: 'workflow',
          workflowId,
          url: access.authUrl,
          via: 'self-contained-auth',
          title: readFlag(argv, '--title'),
          diagram: readFlag(argv, '--diagram'),
          presented: true,
        });
        return 0;
      }
      printJson(await presentWorkflowResult({
        workflowId,
        workflowUrl,
        title: readFlag(argv, '--title'),
        diagram: readFlag(argv, '--diagram'),
        instanceId: selected?.id,
        workspaceRoot,
      }, config));
      return 0;
    }

    if (command === 'show') {
      const selected = readFlag(argv, '--instance')
        ? resolveInstance(config, readFlag(argv, '--instance'), { required: true })
        : undefined;
      const workspaceRoot = readFlag(argv, '--workspace-root') ?? inferWorkspaceRootFromCwd();
      const access = await runtime.resolveInstanceAccess({
        workspaceRoot,
        instanceId: selected?.id,
        syncFolderDefault: workspaceRoot ? 'workspace' : 'global',
        consumer: 'cli',
        mode: argv.includes('--reconcile') ? 'reconcile' : 'observe',
      });
      if (subcommand === 'url' || subcommand === 'auth-url') {
        printTextOrJson(access.authUrl ?? '', argv, { access });
        return 0;
      }
      if (subcommand === 'api-url') {
        printTextOrJson(access.apiBaseUrl, argv, { access });
        return 0;
      }
      if (subcommand === 'public-url') {
        printTextOrJson(access.publicN8nUrl ?? '', argv, { access });
        return 0;
      }
      if (subcommand === 'access') {
        printJson(access);
        return 0;
      }
      throw new Error('Unknown show command. Use: show url|auth-url|api-url|public-url|access');
    }

    if (command === 'auth-bridge') {
      if (subcommand === 'start') {
        await ensureLocalN8nAuthBridgeRunning({ publicTunnel: argv.includes('--tunnel') });
        printJson({ operation: 'auth-bridge.start', ...getLocalN8nAuthBridgeStatus() });
        return 0;
      }
      if (subcommand === 'status' || !subcommand) {
        printJson({ operation: 'auth-bridge.status', ...getLocalN8nAuthBridgeStatus() });
        return 0;
      }
    }

    if (command === 'credentials') {
      const credentials = await createCredentialsManager(argv, config);
      if (subcommand === 'catalog') {
        printJson(await credentials.listCredentialCatalog());
        return 0;
      }

      if (subcommand === 'schema') {
        if (!value) throw new Error('Missing n8n credential type. Example: n8n-manager credentials schema openAiApi');
        printJson(await credentials.getCredentialSchema(value));
        return 0;
      }

      if (subcommand === 'recipes') {
        printJson(await credentials.listRecipes());
        return 0;
      }

      if (subcommand === 'list' || !subcommand) {
        printCredentialInventory((await credentials.getCredentialInventory()).availableCredentials);
        return 0;
      }

      if (subcommand === 'setup') {
        if (!value) throw new Error('Missing recipe id. Example: n8n-manager credentials setup llm-proxy');
        const ref = await credentials.ensureCredential(value, {
          credentialName: readFlag(argv, '--name'),
          values: parseKeyValueFlags(argv),
        });
        printJson({ operation: 'credentials.setup', credential: ref });
        return 0;
      }

      if (subcommand === 'starter-kit') {
        if (!value) {
          printJson(listStarterKits());
          return 0;
        }
        const result = await credentials.bootstrapStarterKit(value);
        printCredentialInventory(result.items);
        return 0;
      }

      if (subcommand === 'test') {
        if (!value) throw new Error('Missing credential id or recipe id.');
        printJson(await credentials.testCredential(value));
        return 0;
      }

      if (subcommand === 'delete') {
        if (!value) throw new Error('Missing credential id or recipe id.');
        printJson({ operation: 'credentials.delete', result: await credentials.deleteCredential(value) });
        return 0;
      }
    }

    if ((command === 'llm-proxy' && subcommand === 'status') || command === 'yagrProxy') {
      const credentials = await createCredentialsManager(argv, config);
      const inventory = await credentials.getCredentialInventory();
      const item = inventory.availableCredentials.find((candidate: CredentialInventoryItem) => candidate.recipeId === 'llm-proxy');
      printJson({
        configured: item?.status === 'ready',
        credentialName: item?.credentialName ?? null,
        credentialId: item?.credentialId ?? null,
        status: item?.status ?? 'missing',
        next: item?.status === 'ready'
          ? 'LLM proxy credential is available to workflow generation.'
          : 'Run `n8n-manager credentials setup llm-proxy --proxyBaseUrl=http://llm-bridge:8080/v1`.',
      });
      return 0;
    }

    throw new Error(`Unknown command: ${argv.join(' ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseMode(value: string): N8nInstanceMode {
  if (value === 'managed-local-docker' || value === 'managed-local-direct' || value === 'existing' || value === 'generation-only') {
    return value;
  }
  throw new Error(`Invalid setup mode: ${value}`);
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  const prefix = `${flag}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function workflowAccessTargetPath(workflowId: string, workflowUrl?: string): string {
  if (workflowUrl) {
    try {
      const parsed = new URL(workflowUrl);
      return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
    } catch {
      // Fall through to ID-based path.
    }
  }
  return `/workflow/${encodeURIComponent(workflowId)}`;
}

function inferWorkspaceRootFromCwd(cwd = process.cwd()): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, 'n8nac-config.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function parseKeyValueFlags(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--') || arg === '--mode' || arg === '--url' || arg === '--name' || arg === '--api-key' || arg === '--project-id' || arg === '--instance') continue;
    const [key, value] = arg.slice(2).split('=', 2);
    if (key && value !== undefined) values[key] = value;
  }
  return values;
}

async function createCredentialsManager(argv: string[], config = new N8nConfigurationService()): Promise<N8nCredentialsManager> {
  const selected = resolveInstance(config, readFlag(argv, '--instance'));
  const effective = await tryPrepareEffectiveContext(config, selected?.id);
  const host = readFlag(argv, '--url') ?? effective?.host ?? process.env.N8N_HOST;
  const apiKey = readFlag(argv, '--api-key') ?? effective?.apiKey ?? process.env.N8N_API_KEY;
  const projectId = readFlag(argv, '--project-id') ?? effective?.projectId ?? process.env.N8N_PROJECT_ID;
  const client = host && apiKey ? new N8nRestCredentialClient({ baseUrl: host, apiKey }) : undefined;
  return new N8nCredentialsManager({ client, projectId });
}

async function tryPrepareEffectiveContext(config: N8nConfigurationService, instanceId?: string) {
  try {
    const runtime = new N8nRuntimeOrchestrator({ configuration: config });
    const prepared = await runtime.prepareEffectiveContext({
      instanceId,
      consumer: 'cli',
      autoStart: true,
    });
    return prepared.runtime.blocked ? undefined : prepared.context;
  } catch {
    return undefined;
  }
}

function resolveInstance(
  config: N8nConfigurationService,
  selector?: string,
  options: { required?: boolean } = {},
): GlobalN8nInstance | undefined {
  const instances = config.listInstances();
  if (!selector) {
    const active = config.getGlobalActiveInstance();
    if (!active && options.required) throw new Error('No active n8n instance is configured.');
    return active;
  }

  const byId = instances.find((instance) => instance.id === selector);
  if (byId) return byId;

  const matches = instances.filter((instance) => instance.name.toLowerCase() === selector.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous n8n instance name: ${selector}. Use an instance id.`);
  if (options.required) throw new Error(`Unknown n8n instance: ${selector}`);
  return undefined;
}

function resolveProject(projects: N8nProjectSnapshot[], selector: string): N8nProjectSnapshot | undefined {
  const normalized = selector.trim().toLowerCase();
  return projects.find((project) => project.id === selector)
    ?? projects.find((project) => project.name.toLowerCase() === normalized)
    ?? projects.find((project) => project.type?.toLowerCase() === normalized);
}

function displayProjectName(project: N8nProjectSnapshot): string {
  return project.type === 'personal' ? 'Personal' : project.name;
}

function toPublicInstance(instance: GlobalN8nInstance): Record<string, unknown> {
  return {
    ...instance,
    apiKeyAvailable: Boolean(instance.apiKeyAvailable),
  };
}

function printCredentialInventory(items: CredentialInventoryItem[]): void {
  const rows = items.map((item) => ({
    recipe: item.recipeId,
    service: item.service,
    status: item.status,
    credential: item.credentialName ?? '',
    reason: item.reason ?? '',
  }));
  console.table(rows);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printTextOrJson(text: string, argv: string[], value: unknown): void {
  if (argv.includes('--json')) {
    printJson(value);
    return;
  }
  console.log(text);
}

function printHelp(): void {
  console.log(`n8n-manager

Usage:
  n8n-manager setup --mode generation-only|managed-local-docker|managed-local-direct|existing [--id ID] [--name NAME] [--url URL] [--tunnel] [--no-bootstrap-owner]
  n8n-manager instances list
  n8n-manager instances add --name NAME --mode existing --url URL --api-key KEY
  n8n-manager instances add --name NAME --mode managed-local-docker [--tunnel] [--no-bootstrap-owner]
  n8n-manager instances select <id-or-name>
  n8n-manager instances setup <id-or-name> [--tunnel] [--no-bootstrap-owner]
  n8n-manager instances start <id-or-name>
  n8n-manager instances stop <id-or-name>
  n8n-manager instances restart <id-or-name>
  n8n-manager instances status <id-or-name>
  n8n-manager instances tunnel start|stop|refresh|status|url <id-or-name>
  n8n-manager instances delete <id-or-name> [--destroy-data --force]
  n8n-manager config get
  n8n-manager config set-sync-folder <path>
  n8n-manager auth set --url URL (--api-key KEY | --api-key-stdin) [--name NAME] [--id ID] [--no-select]
  n8n-manager auth test [--instance <id-or-name>]
  n8n-manager show url|auth-url|api-url|public-url|access [--instance <id-or-name>] [--reconcile] [--json]
  n8n-manager projects list [--instance <id-or-name>]
  n8n-manager projects select <project-id-or-name> [--instance <id-or-name>]
  n8n-manager agent instructions [--write PATH] [--workspace-root PATH]
  n8n-manager presentWorkflowResult --workflow-id <id> [--instance <id-or-name>] [--workspace-root PATH]
  n8n-manager auth-bridge status
  n8n-manager auth-bridge start [--tunnel]
  n8n-manager status [--instance <id-or-name>]
  n8n-manager start [--instance <id-or-name>]
  n8n-manager stop [--instance <id-or-name>]
  n8n-manager restart [--instance <id-or-name>]
  n8n-manager delete [--destroy-data --force]
  n8n-manager credentials list
  n8n-manager credentials catalog
  n8n-manager credentials schema <credential-type>
  n8n-manager credentials recipes
  n8n-manager credentials setup <recipe-id> [--name NAME] [--key=value]
  n8n-manager credentials setup <recipe-id> --url URL --api-key KEY [--project-id ID] [--name NAME] [--key=value]
  n8n-manager credentials starter-kit [starter-kit-id]
  n8n-manager credentials test <credential-id-or-recipe-id>
  n8n-manager credentials delete <credential-id-or-recipe-id>
  n8n-manager llm-proxy status
  n8n-manager yagrProxy
`);
}

function printInstancesHelp(): void {
  console.log(`n8n-manager instances

Usage:
  n8n-manager instances list
  n8n-manager instances add --name NAME --mode existing --url URL --api-key KEY
  n8n-manager instances add --name NAME --mode existing --url URL --api-key-stdin
  n8n-manager instances add --name NAME --mode managed-local-docker [--tunnel] [--no-bootstrap-owner]
  n8n-manager instances select <id-or-name>
  n8n-manager instances setup <id-or-name> [--tunnel] [--no-bootstrap-owner]
  n8n-manager instances start <id-or-name>
  n8n-manager instances stop <id-or-name>
  n8n-manager instances restart <id-or-name>
  n8n-manager instances status <id-or-name>
  n8n-manager instances tunnel start|stop|refresh|status|url <id-or-name>
  n8n-manager instances delete <id-or-name> [--destroy-data --force]

Notes:
  There is no "instances create" command.
  Use "instances add --mode managed-local-docker" for a managed local Docker instance.
  Use "instances add --mode existing --url URL --api-key-stdin" for an existing or remote instance.
`);
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await runCli();
}
