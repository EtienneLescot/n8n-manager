#!/usr/bin/env node
import fs from 'node:fs';
import { FileBackedN8nLifecycleManager, type N8nInstanceMode } from '@n8n-as-code/n8n-manager-core';
import {
  N8nCredentialsManager,
  N8nRestCredentialClient,
  listStarterKits,
  type CredentialInventoryItem,
} from '@n8n-as-code/n8n-credentials-manager';

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, subcommand, value] = argv;
  const lifecycle = new FileBackedN8nLifecycleManager(process.env.N8N_MANAGER_STATE_PATH);
  const credentials = createCredentialsManager(argv);

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
      printJson({
        operation: 'setup',
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
      printJson(await lifecycle.status());
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
      printJson(await lifecycle.delete({ destroyData, force }));
      return 0;
    }

    if (command === 'credentials') {
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
      const inventory = await credentials.getCredentialInventory();
      const item = inventory.availableCredentials.find((candidate) => candidate.recipeId === 'llm-proxy');
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
  return index >= 0 ? argv[index + 1] : undefined;
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

function createCredentialsManager(argv: string[]): N8nCredentialsManager {
  const managed = readManagedInstance();
  const host = readFlag(argv, '--url') ?? process.env.N8N_HOST ?? managed?.baseUrl;
  const apiKey = readFlag(argv, '--api-key') ?? process.env.N8N_API_KEY ?? managed?.apiKey;
  const projectId = readFlag(argv, '--project-id') ?? process.env.N8N_PROJECT_ID;
  const client = host && apiKey ? new N8nRestCredentialClient({ baseUrl: host, apiKey }) : undefined;
  return new N8nCredentialsManager({ client, projectId });
}

function readManagedInstance(): { baseUrl?: string; apiKey?: string } | undefined {
  const statePath = process.env.N8N_MANAGER_STATE_PATH;
  if (!statePath) return undefined;

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as { baseUrl?: string; apiKey?: string };
  } catch {
    return undefined;
  }
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
