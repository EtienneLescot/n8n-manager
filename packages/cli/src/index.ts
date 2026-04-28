#!/usr/bin/env node
import fs from 'node:fs';
import {
  FileBackedN8nLifecycleManager,
  N8nConfigurationService,
  readFileBackedN8nInstance,
  type GlobalN8nInstance,
  type N8nInstanceMode,
} from '@n8n-as-code/n8n-manager-core';
import {
  N8nCredentialsManager,
  N8nRestCredentialClient,
  listStarterKits,
  type CredentialInventoryItem,
} from '@n8n-as-code/n8n-credentials-manager';

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, subcommand, value] = argv;
  const config = new N8nConfigurationService();
  const lifecycle = new FileBackedN8nLifecycleManager(process.env.N8N_MANAGER_STATE_PATH);

  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      printHelp();
      return 0;
    }

    if (command === 'setup') {
      const mode = parseMode(readFlag(argv, '--mode') ?? 'generation-only');
      const baseUrl = readFlag(argv, '--url');
      const snapshot = await lifecycle.setup({
        mode,
        baseUrl,
        tunnel: argv.includes('--tunnel'),
        bootstrapOwner: !argv.includes('--no-bootstrap-owner'),
      });
      const privateSnapshot = await readFileBackedN8nInstance(process.env.N8N_MANAGER_STATE_PATH);
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
      const selected = resolveInstance(config, readFlag(argv, '--instance'));
      if (selected?.runtimeStatePath) {
        printJson(await new FileBackedN8nLifecycleManager(selected.runtimeStatePath).status());
      } else if (selected) {
        printJson({
          status: selected.mode === 'generation-only' ? 'stopped' : 'ready',
          instance: toPublicInstance(selected),
          checks: [{ id: 'instance', label: 'n8n instance', status: 'pass', message: 'Global instance configuration is present.' }],
        });
      } else {
        printJson(config.getGlobalConfig());
      }
      return 0;
    }

    if (command === 'start') {
      printJson(await lifecycle.start());
      return 0;
    }

    if (command === 'stop') {
      printJson(await lifecycle.stop());
      return 0;
    }

    if (command === 'restart') {
      printJson(await lifecycle.restart());
      return 0;
    }

    if (command === 'delete') {
      const destroyData = argv.includes('--destroy-data');
      const force = argv.includes('--force');
      if (destroyData && !force) {
        throw new Error('Refusing to destroy n8n data without --force.');
      }
      const selected = resolveInstance(config, readFlag(argv, '--instance'));
      if (selected?.runtimeStatePath) {
        printJson(await new FileBackedN8nLifecycleManager(selected.runtimeStatePath).delete({ destroyData, force }));
      } else {
        printJson(await lifecycle.delete({ destroyData, force }));
      }
      return 0;
    }

    if (command === 'instances') {
      if (subcommand === 'list' || !subcommand) {
        printJson(config.getGlobalConfig());
        return 0;
      }

      if (subcommand === 'add') {
        const baseUrl = readFlag(argv, '--url');
        const apiKey = readFlag(argv, '--api-key');
        const mode = parseMode(readFlag(argv, '--mode') ?? 'existing');
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
          await new FileBackedN8nLifecycleManager(instance.runtimeStatePath).delete({ destroyData, force });
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

    if (command === 'credentials') {
      const credentials = createCredentialsManager(argv, config);
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

    if (command === 'llm-proxy' && subcommand === 'status') {
      const credentials = createCredentialsManager(argv, config);
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

function parseKeyValueFlags(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--') || arg === '--mode' || arg === '--url' || arg === '--name' || arg === '--api-key' || arg === '--project-id') continue;
    const [key, value] = arg.slice(2).split('=', 2);
    if (key && value !== undefined) values[key] = value;
  }
  return values;
}

function createCredentialsManager(argv: string[], config = new N8nConfigurationService()): N8nCredentialsManager {
  const selected = resolveInstance(config, readFlag(argv, '--instance'));
  const effective = selected
    ? config.resolveEffectiveContext({ instanceId: selected.id })
    : tryResolveEffectiveContext(config);
  const host = readFlag(argv, '--url') ?? effective?.host ?? process.env.N8N_HOST;
  const apiKey = readFlag(argv, '--api-key') ?? effective?.apiKey ?? process.env.N8N_API_KEY;
  const projectId = readFlag(argv, '--project-id') ?? effective?.projectId ?? process.env.N8N_PROJECT_ID;
  const client = host && apiKey ? new N8nRestCredentialClient({ baseUrl: host, apiKey }) : undefined;
  return new N8nCredentialsManager({ client, projectId });
}

function tryResolveEffectiveContext(config: N8nConfigurationService) {
  try {
    return config.resolveEffectiveContext();
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

function printHelp(): void {
  console.log(`n8n-manager

Usage:
  n8n-manager setup --mode generation-only|managed-local-docker|managed-local-direct|existing [--url URL] [--tunnel] [--no-bootstrap-owner]
  n8n-manager instances list
  n8n-manager instances add --name NAME --mode existing --url URL --api-key KEY
  n8n-manager instances select <id-or-name>
  n8n-manager instances delete <id-or-name> [--destroy-data --force]
  n8n-manager config get
  n8n-manager config set-sync-folder <path>
  n8n-manager status
  n8n-manager start
  n8n-manager stop
  n8n-manager restart
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
