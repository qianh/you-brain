import { describe, expect, it } from "bun:test";

import {
  MemorySecretStore,
  MigratingSecretStore,
} from "../../src/auth/secret-store.js";

describe("migrating secret store", () => {
  it("restores the primary credential when legacy deletion fails", async () => {
    const primary = new MemorySecretStore("credential");
    const legacy = new MemorySecretStore("legacy-credential");
    legacy.delete = async () => {
      throw new Error("legacy keychain unavailable");
    };
    const secrets = new MigratingSecretStore(primary, legacy);

    await expect(secrets.delete()).rejects.toThrow(/legacy keychain unavailable/);
    await expect(primary.get()).resolves.toBe("credential");
  });

  it("copies a legacy secret into the primary store", async () => {
    const primary = new MemorySecretStore(null);
    const legacy = new MemorySecretStore("legacy-token");
    const secrets = new MigratingSecretStore(primary, legacy);
    await expect(secrets.get()).resolves.toBe("legacy-token");
    await expect(primary.get()).resolves.toBe("legacy-token");
    await expect(legacy.get()).resolves.toBeNull();
  });
});
