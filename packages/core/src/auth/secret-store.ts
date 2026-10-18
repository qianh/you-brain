export interface SecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
  probe?(): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  constructor(public value: string | null = null) {}

  async probe(): Promise<void> {
    return undefined;
  }

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(value: string): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}

/** In-memory keychain. Tests use this instead of the `security` command. */
export class MemoryKeychain {
  readonly #items = new Map<string, string>();

  static key(service: string, account: string): string {
    return `${service}\0${account}`;
  }

  get(service: string, account: string): string | null {
    return this.#items.get(MemoryKeychain.key(service, account)) ?? null;
  }

  set(service: string, account: string, value: string): void {
    this.#items.set(MemoryKeychain.key(service, account), value);
  }

  delete(service: string, account: string): void {
    this.#items.delete(MemoryKeychain.key(service, account));
  }

  store(service: string, account: string): SecretStore {
    return {
      probe: async () => undefined,
      get: async () => this.get(service, account),
      set: async (value: string) => {
        this.set(service, account, value);
      },
      delete: async () => {
        this.delete(service, account);
      },
    };
  }
}

export class MigratingSecretStore implements SecretStore {
  constructor(
    readonly primary: SecretStore,
    readonly legacy: SecretStore,
  ) {}

  async probe(): Promise<void> {
    await this.primary.probe?.();
  }

  async get(): Promise<string | null> {
    const current = await this.primary.get();
    if (current) return current;
    const legacy = await this.legacy.get();
    if (!legacy) return null;
    await this.primary.set(legacy);
    await this.legacy.delete();
    return legacy;
  }

  async set(value: string): Promise<void> {
    await this.primary.set(value);
  }

  async delete(): Promise<void> {
    const previous = await this.primary.get();
    await this.primary.delete();
    try {
      await this.legacy.delete();
    } catch (error) {
      try {
        if (previous !== null) await this.primary.set(previous);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Legacy credential deletion and primary credential restore both failed",
          { cause: restoreError },
        );
      }
      throw error;
    }
  }
}
