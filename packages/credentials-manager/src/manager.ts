import { getCredentialRecipe, listCredentialRecipes, listStarterKits } from './recipes.js';
import { createEmptyCredentialInventory, FileCredentialStateStore } from './store.js';
import { createDefaultCredentialCatalogProvider, overlayStarterRecipes } from './catalog.js';
import type {
  CredentialCatalogEntry,
  CredentialCatalogProvider,
  CredentialInventory,
  CredentialInventoryItem,
  CredentialRecipe,
  CredentialStateStore,
  CredentialStatus,
  CredentialTestResult,
  EnsureCredentialInput,
  N8nCredentialClient,
  N8nCredentialRef,
  StarterKit,
  StarterKitResult,
} from './types.js';

export interface N8nCredentialsManagerOptions {
  store?: CredentialStateStore;
  client?: N8nCredentialClient;
  catalogProvider?: CredentialCatalogProvider;
  now?: () => Date;
  projectId?: string;
}

export class N8nCredentialsManager {
  private readonly store: CredentialStateStore;
  private readonly client?: N8nCredentialClient;
  private readonly catalogProvider: CredentialCatalogProvider;
  private readonly now: () => Date;
  private readonly projectId?: string;

  constructor(options: N8nCredentialsManagerOptions = {}) {
    this.store = options.store ?? new FileCredentialStateStore();
    this.client = options.client;
    this.catalogProvider = options.catalogProvider ?? createDefaultCredentialCatalogProvider();
    this.now = options.now ?? (() => new Date());
    this.projectId = options.projectId;
  }

  async listRecipes(): Promise<CredentialRecipe[]> {
    return listCredentialRecipes();
  }

  async listStarterKits(): Promise<StarterKit[]> {
    return listStarterKits();
  }

  async listCredentialCatalog(): Promise<CredentialCatalogEntry[]> {
    const catalog = await this.catalogProvider.listCredentialTypes().catch(() => []);
    return overlayStarterRecipes(catalog);
  }

  async getCredentialSchema(typeName: string): Promise<Record<string, unknown>> {
    if (this.client?.getCredentialSchema) {
      try {
        return await this.client.getCredentialSchema(typeName);
      } catch {
        // Public n8n API keys may be allowed to create credentials while still
        // being denied live schema introspection. Facades must keep working from
        // the generated n8n ontology in that case.
      }
    }

    const entry = (await this.listCredentialCatalog()).find((candidate) => candidate.typeName === typeName);
    if (!entry) {
      throw new Error(`Unknown n8n credential type: ${typeName}`);
    }

    return entry.schema ?? {
      typeName: entry.typeName,
      displayName: entry.displayName,
      properties: entry.properties ?? [],
      usedByNodes: entry.usedByNodes,
      source: entry.source,
    };
  }

  async getCredentialInventory(): Promise<CredentialInventory> {
    const existing = await this.store.readInventory();
    const byRecipe = new Map(existing.availableCredentials.map((item) => [item.recipeId, item]));
    const merged = listCredentialRecipes().map((recipe) => byRecipe.get(recipe.id) ?? this.buildInventoryItem(recipe, this.defaultMissingStatus(recipe), undefined));
    return { availableCredentials: merged };
  }

  async listCredentials(): Promise<N8nCredentialRef[]> {
    if (this.client) {
      try {
        return await this.client.listCredentials();
      } catch {
        // Keep facades usable when a runtime key can create/update credentials
        // but cannot list them, for example after n8n API scope changes.
      }
    }

    const inventory = await this.store.readInventory().catch(() => createEmptyCredentialInventory());
    return inventory.availableCredentials
      .filter((item) => item.credentialId && item.credentialName)
      .map((item) => ({
        id: item.credentialId ?? '',
        name: item.credentialName ?? item.recipeId,
        type: item.credentialTypeName,
        recipeId: item.recipeId,
        service: item.service,
      }));
  }

  async ensureCredentialType(input: {
    credentialId?: string;
    credentialName: string;
    credentialTypeName: string;
    values: Record<string, unknown>;
  }): Promise<N8nCredentialRef> {
    const catalogEntry = (await this.listCredentialCatalog()).find((candidate) => candidate.typeName === input.credentialTypeName);
    if (!catalogEntry) {
      throw new Error(`Unknown n8n credential type: ${input.credentialTypeName}`);
    }

    const recipe = listCredentialRecipes().find((candidate) => candidate.credentialTypeName === input.credentialTypeName);
    const recipeId = recipe?.id ?? `type:${input.credentialTypeName}:${input.credentialId || input.credentialName}`;
    const service = recipe?.service ?? 'n8n';
    const ref = this.client
      ? await this.client.upsertCredential({
          id: input.credentialId,
          name: input.credentialName,
          type: input.credentialTypeName,
          data: input.values,
          recipeId,
          service,
          projectId: this.projectId,
        })
      : {
          id: input.credentialId ?? `${recipeId}:planned`,
          name: input.credentialName,
          type: input.credentialTypeName,
          recipeId,
          service,
        };

    await this.upsertInventoryItem({
      recipeId,
      service,
      nodes: catalogEntry.usedByNodes.map((node) => node.nodeDisplayName ?? node.nodeName),
      credentialName: ref.name,
      credentialId: ref.id,
      credentialTypeName: ref.type,
      status: 'ready',
      updatedAt: this.now().toISOString(),
    });
    return ref;
  }

  async ensureCredential(recipeId: string, input: EnsureCredentialInput = {}): Promise<N8nCredentialRef> {
    const recipe = this.requireRecipe(recipeId);
    if (recipe.authMethod === 'llm-proxy' && !input.source && !input.values?.proxyBaseUrl && !input.values?.url) {
      await this.upsertInventoryItem(this.buildInventoryItem(
        recipe,
        'missing',
        'Missing LLM source or proxyBaseUrl.',
        input.credentialName,
      ));
      throw new Error(`Cannot ensure ${recipe.id}: missing LLM source or proxyBaseUrl`);
    }

    const missingInputs = recipe.requiredInputs.filter((field) => field.required && isMissingInput(input.values?.[field.key]));
    if (recipe.authMethod !== 'llm-proxy' && missingInputs.length > 0) {
      await this.upsertInventoryItem(this.buildInventoryItem(
        recipe,
        this.statusForMissingInput(recipe),
        `Missing required input: ${missingInputs.map((field) => field.key).join(', ')}`,
        input.credentialName,
      ));
      throw new Error(`Cannot ensure ${recipe.id}: missing required input ${missingInputs.map((field) => field.key).join(', ')}`);
    }

    const credentialName = input.credentialName ?? recipe.label;
    const data = await this.buildCredentialData(recipe, input);
    const ref = this.client
      ? await this.client.upsertCredential({
          name: credentialName,
          type: recipe.credentialTypeName,
          data,
          recipeId: recipe.id,
          service: recipe.service,
          projectId: this.projectId,
        })
      : {
          id: `${recipe.id}:planned`,
          name: credentialName,
          type: recipe.credentialTypeName,
          recipeId: recipe.id,
          service: recipe.service,
        };

    await this.upsertInventoryItem(this.buildInventoryItem(recipe, 'ready', undefined, ref.name, ref.id));
    return ref;
  }

  async deleteCredential(credentialIdOrRecipeId: string): Promise<{ credentialId?: string; recipeId?: string; deletedRemote: boolean; deletedInventory: boolean }> {
    const inventory = await this.store.readInventory().catch(() => createEmptyCredentialInventory());
    const item = inventory.availableCredentials.find((candidate) =>
      candidate.credentialId === credentialIdOrRecipeId || candidate.recipeId === credentialIdOrRecipeId,
    );
    const credentialId = item?.credentialId ?? credentialIdOrRecipeId;

    let deletedRemote = false;
    if (this.client?.deleteCredential && credentialId && !credentialId.endsWith(':planned')) {
      await this.client.deleteCredential(credentialId);
      deletedRemote = true;
    }

    const nextItems = inventory.availableCredentials.filter((candidate) =>
      candidate.credentialId !== credentialIdOrRecipeId
      && candidate.recipeId !== credentialIdOrRecipeId
      && candidate.credentialId !== credentialId,
    );
    const deletedInventory = nextItems.length !== inventory.availableCredentials.length;
    await this.store.writeInventory({ availableCredentials: nextItems });

    return {
      credentialId,
      recipeId: item?.recipeId,
      deletedRemote,
      deletedInventory,
    };
  }

  async testCredential(credentialIdOrRecipeId: string): Promise<CredentialTestResult> {
    const inventory = await this.store.readInventory();
    const item = inventory.availableCredentials.find((candidate) =>
      candidate.credentialId === credentialIdOrRecipeId || candidate.recipeId === credentialIdOrRecipeId,
    );
    const credentialId = item?.credentialId ?? credentialIdOrRecipeId;

    if (this.client?.testCredential) {
      const result = await this.client.testCredential(credentialId);
      if (item && result.status === 'fail') {
        await this.upsertInventoryItem({ ...item, status: 'test-failed', reason: result.message, updatedAt: this.now().toISOString() });
      }
      return result;
    }

    return {
      credentialId,
      status: item?.status === 'ready' ? 'skip' : 'fail',
      message: item?.status === 'ready'
        ? 'Credential is marked ready locally; no n8n client is configured for an active probe.'
        : 'Credential is not ready and no n8n client is configured for an active probe.',
    };
  }

  async bootstrapStarterKit(starterKitId: string, inputs: Record<string, EnsureCredentialInput> = {}): Promise<StarterKitResult> {
    const kit = listStarterKits().find((candidate) => candidate.id === starterKitId);
    if (!kit) {
      throw new Error(`Unknown starter kit: ${starterKitId}`);
    }

    const items: CredentialInventoryItem[] = [];
    for (const recipeId of kit.recipeIds) {
      const recipe = this.requireRecipe(recipeId);
      try {
        await this.ensureCredential(recipeId, inputs[recipeId] ?? {});
      } catch {
        // The inventory entry already carries the actionable state.
      }
      const inventory = await this.store.readInventory();
      const item = inventory.availableCredentials.find((candidate) => candidate.recipeId === recipe.id)
        ?? this.buildInventoryItem(recipe, this.defaultMissingStatus(recipe), undefined);
      items.push(item);
    }

    return { starterKitId, items };
  }

  private requireRecipe(recipeId: string): CredentialRecipe {
    const recipe = getCredentialRecipe(recipeId);
    if (!recipe) {
      throw new Error(`Unknown credential recipe: ${recipeId}`);
    }
    return recipe;
  }

  private async buildCredentialData(recipe: CredentialRecipe, input: EnsureCredentialInput): Promise<Record<string, unknown>> {
    if (recipe.authMethod === 'llm-proxy') {
      const descriptor = await input.source?.getDescriptor();
      const proxyBaseUrl = descriptor?.proxyBaseUrl ?? input.values?.proxyBaseUrl ?? input.values?.url ?? 'http://llm-bridge:8080/v1';
      return {
        apiKey: input.values?.proxyToken ?? input.values?.apiKey ?? 'proxy-local-token',
        url: proxyBaseUrl,
        sourceId: input.source?.id,
        sourceLabel: input.source?.label,
        provider: descriptor?.provider,
        model: descriptor?.model,
        mode: input.mode ?? 'proxy',
      };
    }

    return { ...(input.values ?? {}) };
  }

  private defaultMissingStatus(recipe: CredentialRecipe): CredentialStatus {
    if (recipe.authMethod === 'oauth2') return 'requires-oauth';
    if (recipe.authMethod === 'api-key' || recipe.authMethod === 'pat') return 'requires-api-key';
    if (recipe.authMethod === 'llm-proxy') return 'missing';
    return 'missing';
  }

  private statusForMissingInput(recipe: CredentialRecipe): CredentialStatus {
    if (recipe.authMethod === 'oauth2') return 'requires-oauth';
    if (recipe.authMethod === 'api-key' || recipe.authMethod === 'pat') return 'requires-api-key';
    return 'partially-configured';
  }

  private buildInventoryItem(
    recipe: CredentialRecipe,
    status: CredentialStatus,
    reason?: string,
    credentialName?: string,
    credentialId?: string,
  ): CredentialInventoryItem {
    return {
      recipeId: recipe.id,
      service: recipe.service,
      nodes: [...recipe.supportedNodes],
      credentialName,
      credentialId,
      credentialTypeName: recipe.credentialTypeName,
      status,
      reason,
      updatedAt: this.now().toISOString(),
    };
  }

  private async upsertInventoryItem(item: CredentialInventoryItem): Promise<void> {
    const inventory = await this.store.readInventory().catch(() => createEmptyCredentialInventory());
    const nextItems = inventory.availableCredentials.filter((candidate) => candidate.recipeId !== item.recipeId);
    nextItems.push(item);
    await this.store.writeInventory({ availableCredentials: nextItems });
  }
}

function isMissingInput(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}
