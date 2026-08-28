/**
 * Mobile 本地存储键迁移。
 *
 * Phase 6.0 将旧 Mobile 身份键收敛为正式命名。迁移遵循 copy → verify → delete：
 * 只有新键读取结果与旧值一致时才删除旧键；冲突或存储异常会保留旧键，
 * 让下一次启动仍有机会完成迁移。
 */

export type MobileStorage = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

export type MobileKeyMigrationDependencies = {
  storage: MobileStorage;
  digest: (value: string) => Promise<string>;
};

const EXACT_KEYS: readonly [oldKey: string, newKey: string][] = [
  ["weflow.client1.mobile-session", "weflow.mobile.session"],
  ["weflow.client1.recent-accounts", "weflow.mobile.recent-accounts"],
  ["client1.theme.mode", "mobile.theme.mode"],
  ["weflow.client1.brief-read-state", "weflow.mobile.brief-read-state"],
];

const ACCOUNT_PREFIXES: readonly [oldPrefix: string, newPrefix: string][] = [
  [
    "weflow.client1.notification-preference.",
    "weflow.mobile.notification-preference.",
  ],
  ["weflow.client1.krecents.", "weflow.mobile.krecents."],
  ["weflow.client1.kfav.", "weflow.mobile.kfav."],
  ["weflow.client1.draft.", "weflow.mobile.draft."],
  ["weflow.client1.transcript-cache.", "weflow.mobile.transcript-cache."],
];

/** 执行一次可重入的本地键迁移。迁移失败由调用方记录并在下次启动重试。 */
export async function migrateMobileStorageKeys(
  dependencies: MobileKeyMigrationDependencies,
  accountId?: string,
): Promise<void> {
  for (const [oldKey, newKey] of EXACT_KEYS) {
    await migrateKey(dependencies.storage, oldKey, newKey);
  }

  if (!accountId) return;
  const digest = await dependencies.digest(accountId);
  for (const [oldPrefix, newPrefix] of ACCOUNT_PREFIXES) {
    await migrateKey(
      dependencies.storage,
      `${oldPrefix}${digest}`,
      `${newPrefix}${digest}`,
    );
  }

  await migrateIndexedKeys(
    dependencies.storage,
    `weflow.client1.draft-index.${digest}`,
    `weflow.mobile.draft-index.${digest}`,
    "weflow.client1.draft.",
    "weflow.mobile.draft.",
  );
  await migrateIndexedKeys(
    dependencies.storage,
    `weflow.client1.transcript-cache-index.${digest}`,
    `weflow.mobile.transcript-cache-index.${digest}`,
    "weflow.client1.transcript-cache.",
    "weflow.mobile.transcript-cache.",
  );
}

async function migrateKey(
  storage: MobileStorage,
  oldKey: string,
  newKey: string,
): Promise<void> {
  const oldValue = await storage.getItemAsync(oldKey);
  if (oldValue === null) return;

  const newValue = await storage.getItemAsync(newKey);
  if (newValue === null) {
    await storage.setItemAsync(newKey, oldValue);
  }
  if ((await storage.getItemAsync(newKey)) === oldValue) {
    await storage.deleteItemAsync(oldKey);
  }
}

async function migrateIndexedKeys(
  storage: MobileStorage,
  oldIndexKey: string,
  newIndexKey: string,
  oldItemPrefix: string,
  newItemPrefix: string,
): Promise<void> {
  const oldIndex = await storage.getItemAsync(oldIndexKey);
  if (oldIndex === null) return;

  const oldItems = parseStringArray(oldIndex);
  const currentItems = parseStringArray(
    (await storage.getItemAsync(newIndexKey)) ?? "[]",
  );
  const migratedItems = new Set(currentItems);

  for (const oldItemKey of oldItems) {
    if (!oldItemKey.startsWith(oldItemPrefix)) continue;
    const newItemKey = `${newItemPrefix}${oldItemKey.slice(oldItemPrefix.length)}`;
    await migrateKey(storage, oldItemKey, newItemKey);
    if ((await storage.getItemAsync(newItemKey)) !== null) {
      migratedItems.add(newItemKey);
    }
  }

  const nextIndex = JSON.stringify([...migratedItems]);
  await storage.setItemAsync(newIndexKey, nextIndex);
  if ((await storage.getItemAsync(newIndexKey)) === nextIndex) {
    await storage.deleteItemAsync(oldIndexKey);
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
