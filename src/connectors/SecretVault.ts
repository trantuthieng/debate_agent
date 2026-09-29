import type * as vscode from 'vscode';

/** Narrow secret interface keeps credentials out of workspace files and logs. */
export interface SecretVault {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class VSCodeSecretVault implements SecretVault {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  async get(key: string): Promise<string | undefined> { return this.secrets.get(key); }
  async store(key: string, value: string): Promise<void> { await this.secrets.store(key, value); }
  async delete(key: string): Promise<void> { await this.secrets.delete(key); }
}
