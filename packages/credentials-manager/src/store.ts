import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CredentialInventory, CredentialStateStore } from './types.js';

export function createEmptyCredentialInventory(): CredentialInventory {
  return { availableCredentials: [] };
}

export class FileCredentialStateStore implements CredentialStateStore {
  constructor(private readonly filePath = path.join(os.homedir(), '.n8n-manager', 'credential-inventory.json')) {}

  async readInventory(): Promise<CredentialInventory> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as CredentialInventory;
      return {
        availableCredentials: Array.isArray(parsed.availableCredentials) ? parsed.availableCredentials : [],
      };
    } catch {
      return createEmptyCredentialInventory();
    }
  }

  async writeInventory(inventory: CredentialInventory): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(inventory, null, 2));
  }
}

export class MemoryCredentialStateStore implements CredentialStateStore {
  private inventory = createEmptyCredentialInventory();

  async readInventory(): Promise<CredentialInventory> {
    return { availableCredentials: this.inventory.availableCredentials.map((item) => ({ ...item, nodes: [...item.nodes] })) };
  }

  async writeInventory(inventory: CredentialInventory): Promise<void> {
    this.inventory = { availableCredentials: inventory.availableCredentials.map((item) => ({ ...item, nodes: [...item.nodes] })) };
  }
}
