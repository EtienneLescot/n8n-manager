import { getCredentialRecipe, listCredentialRecipes, listStarterKits } from './recipes.js';
import { createEmptyCredentialInventory, FileCredentialStateStore } from './store.js';
import type {
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
  now?: () => Date;
  projectId?: string;
}

export class N8nCredentialsManager {
  private readonly store: CredentialStateStore;
  private readonly client?: N8nCredentialClient;
  private readonly now: () => Date;
  private readonly projectId?: string;

  constructor(options: N8nCredentialsManagerOptions = {}) {
    this.store = options.store ?? new FileCredentialStateStore();
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.projectId = options.projectId;
  }

  async listRecipes(): Promise<CredentialRecipe[]> {
    return listCredentialRecipes();
  }

  async listStarterKits(): Promise<StarterKit[]> {
    return listStarterKits();
  }

  async getCredentialInventory(): Promise<CredentialInventory> {
    const existing = await this.store.readInventory();
    const byRecipe = new Map(existing.availableCredentials.map((item) => [item.recipeId, item]));
    const merged = listCredentialRecipes().map((recipe) => byRecipe.get(recipe.id) ?? this.buildInventoryItem(recipe, this.defaultMissingStatus(recipe), undefined));
    return { availableCredentials: merged };
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

    const missingInputs = recipe.requiredInputs.filter((field) => field.required && !input.values?.[field.key]);
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
