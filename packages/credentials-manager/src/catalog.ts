import fs from 'node:fs/promises';
import { listCredentialRecipes } from './recipes.js';
import type { CredentialCatalogEntry, CredentialCatalogProvider, CredentialRecipe } from './types.js';

interface N8nCredentialOntologyFile {
  credentials?: Array<{
    typeName?: string;
    name?: string;
    displayName?: string;
    documentationUrl?: string;
    properties?: unknown[];
    usedByNodes?: CredentialCatalogEntry['usedByNodes'];
  }>;
}

export class FileCredentialCatalogProvider implements CredentialCatalogProvider {
  constructor(private readonly filePath: string) {}

  async listCredentialTypes(): Promise<CredentialCatalogEntry[]> {
    const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as N8nCredentialOntologyFile;
    const credentials = raw.credentials ?? [];
    const entries: CredentialCatalogEntry[] = [];
    for (const credential of credentials) {
        const typeName = credential.typeName ?? credential.name;
        if (!typeName) continue;
        entries.push({
          typeName,
          displayName: credential.displayName ?? typeName,
          documentationUrl: credential.documentationUrl,
          properties: credential.properties,
          usedByNodes: credential.usedByNodes ?? [],
          source: 'n8n-ontology' as const,
          starterRecipeIds: [],
        });
    }
    return entries;
  }

  async getCredentialType(typeName: string): Promise<CredentialCatalogEntry | undefined> {
    return (await this.listCredentialTypes()).find((entry) => entry.typeName === typeName);
  }
}

export class RecipeCredentialCatalogProvider implements CredentialCatalogProvider {
  constructor(private readonly recipes: CredentialRecipe[] = listCredentialRecipes()) {}

  async listCredentialTypes(): Promise<CredentialCatalogEntry[]> {
    return mergeCredentialCatalogEntries(this.recipes.map(recipeToCatalogEntry));
  }

  async getCredentialType(typeName: string): Promise<CredentialCatalogEntry | undefined> {
    return (await this.listCredentialTypes()).find((entry) => entry.typeName === typeName);
  }
}

export function createDefaultCredentialCatalogProvider(): CredentialCatalogProvider {
  const ontologyPath = process.env.N8N_CREDENTIAL_ONTOLOGY_PATH;
  return ontologyPath ? new FileCredentialCatalogProvider(ontologyPath) : new RecipeCredentialCatalogProvider();
}

export function mergeCredentialCatalogEntries(entries: CredentialCatalogEntry[]): CredentialCatalogEntry[] {
  const byType = new Map<string, CredentialCatalogEntry>();

  for (const entry of entries) {
    const existing = byType.get(entry.typeName);
    if (!existing) {
      byType.set(entry.typeName, {
        ...entry,
        usedByNodes: [...entry.usedByNodes],
        starterRecipeIds: [...entry.starterRecipeIds],
      });
      continue;
    }

    byType.set(entry.typeName, {
      ...existing,
      displayName: existing.displayName || entry.displayName,
      documentationUrl: existing.documentationUrl ?? entry.documentationUrl,
      properties: existing.properties ?? entry.properties,
      schema: existing.schema ?? entry.schema,
      usedByNodes: mergeNodeUsages(existing.usedByNodes, entry.usedByNodes),
      source: existing.source === 'n8n-ontology' ? existing.source : entry.source,
      starterRecipeIds: Array.from(new Set([...existing.starterRecipeIds, ...entry.starterRecipeIds])),
    });
  }

  return Array.from(byType.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function overlayStarterRecipes(entries: CredentialCatalogEntry[], recipes = listCredentialRecipes()): CredentialCatalogEntry[] {
  return mergeCredentialCatalogEntries([
    ...entries,
    ...recipes.map(recipeToCatalogEntry),
  ]);
}

function recipeToCatalogEntry(recipe: CredentialRecipe): CredentialCatalogEntry {
  return {
    typeName: recipe.credentialTypeName,
    displayName: recipe.label,
    properties: recipe.requiredInputs.map((input) => ({
      displayName: input.label,
      name: input.key,
      type: 'string',
      typeOptions: input.secret ? { password: true } : undefined,
      required: input.required,
      default: '',
      description: input.description,
    })),
    usedByNodes: recipe.supportedNodes.map((nodeDisplayName) => ({ nodeName: nodeDisplayName, nodeDisplayName })),
    source: 'starter-overlay',
    starterRecipeIds: [recipe.id],
  };
}

function mergeNodeUsages(
  first: CredentialCatalogEntry['usedByNodes'],
  second: CredentialCatalogEntry['usedByNodes'],
): CredentialCatalogEntry['usedByNodes'] {
  const byKey = new Map<string, CredentialCatalogEntry['usedByNodes'][number]>();
  for (const usage of [...first, ...second]) {
    byKey.set(`${usage.nodeType ?? ''}:${usage.nodeName}:${usage.nodeDisplayName ?? ''}`, usage);
  }
  return Array.from(byKey.values());
}
