import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Sum of the relay files. Same diskBytes limit openRelayState enforces. */
export const RELAY_DISK_BYTES = 64 * 1024 * 1024;

const STORAGE_NAMES = [
  "relay.sqlite",
  "relay.sqlite-wal",
  "relay.sqlite-shm",
  "worker.lock",
  "profile",
];

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export class RelayStorageError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RelayStorageError";
    this.code = code;
  }
}

export function relayProfileMismatchError() {
  return new Error(
    "Relay profile mismatch. This directory was written for a different account or environment, or by an older version of gbot, and old bindings are not adopted. The stored profile includes the account, gateway and token settings, thread limits, and the DISPLAY or DBUS session, so a profile can change for reasons other than an upgrade. Run again with the same account and environment to keep this directory. If an older version wrote it, upgrade in this order: with the old version, run `gbot codex bridge stop --worker` before upgrading; that version's `bridge status` includes worker.pid. A pinned GROK_BOT_RELAY_DIR keeps the same socket path. If a still-running old worker is reached on that socket, it rejects this hello and does not stop. Stop the process that has the directory's control.sock or worker.lock open (for example `lsof -t <dir>/worker.lock`), then move or rename the directory, or choose a new GROK_BOT_RELAY_DIR, and bind again. Only the default directory's socket path changes, because it is derived from the profile hash; its old state stays in ~/.grok-bot-cli/relay/<old hash>.",
  );
}

function sqlitePrimaryCode(error) {
  const errcode = error?.errcode;
  return typeof errcode === "number" ? errcode & 0xff : undefined;
}

function asStorageError(error) {
  if (error instanceof RelayStorageError) return error;
  const code = sqlitePrimaryCode(error);
  const message = String(error?.message ?? "");
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED || /database is locked|sqlite_busy|sqlite_locked/i.test(message)) {
    return new RelayStorageError("locked", "Relay state is locked", { cause: error });
  }
  if (code !== undefined || (typeof error?.code === "string" && error.code.startsWith("ERR_SQLITE"))) {
    return new RelayStorageError("corrupt", "Relay state is corrupt", { cause: error });
  }
  return error;
}

async function fileInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertStorageBudget(dir, maxBytes) {
  let total = 0;
  for (const name of STORAGE_NAMES) {
    const info = await fileInfo(join(dir, name));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RelayStorageError(
        "corrupt",
        "Relay storage must be an owned regular file, never a symlink",
      );
    }
    total += info.size;
    if (total > maxBytes) {
      throw new RelayStorageError("capacity", "Relay storage capacity exceeded");
    }
  }
}

/**
 * Profile stored in agent_state_head by the relay state driver.
 * Read-only: a locked or corrupt file throws RelayStorageError and is not guessed.
 */
export async function readStoredRelayProfile(dir, {
  busyTimeoutMs = 5000,
  maxBytes = RELAY_DISK_BYTES,
} = {}) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1) {
    throw new Error("Invalid relay busy timeout");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RelayStorageError("capacity", "Relay storage capacity exceeded");
  }
  const info = await fileInfo(join(dir, "relay.sqlite"));
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new RelayStorageError(
      "corrupt",
      "Relay storage must be an owned regular file, never a symlink",
    );
  }
  await assertStorageBudget(dir, maxBytes);
  if (!info) return null;
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    // A checkpointed database has no WAL. immutable=1 reads that file and does
    // not create -wal/-shm. A WAL is still present while a writer is open or
    // after a crash; only then does a normal read-only connection see it.
    const wal = await fileInfo(join(dir, "relay.sqlite-wal"));
    const location = wal
      ? join(dir, "relay.sqlite")
      : `${pathToFileURL(join(dir, "relay.sqlite")).href}?immutable=1`;
    db = new DatabaseSync(location, {
      readOnly: true,
      timeout: busyTimeoutMs,
    });
    const row = db.prepare("SELECT state FROM agent_state_head WHERE id = 1").get();
    if (!row || typeof row.state !== "string") {
      throw new RelayStorageError("corrupt", "Relay state is corrupt");
    }
    let parsed;
    try {
      parsed = JSON.parse(row.state);
    } catch (cause) {
      throw new RelayStorageError("corrupt", "Relay state is corrupt", { cause });
    }
    const profile = parsed?.profile;
    if (typeof profile !== "string" || profile.length < 1) {
      throw new RelayStorageError("corrupt", "Relay state is corrupt");
    }
    return profile;
  } catch (error) {
    throw asStorageError(error);
  } finally {
    try {
      db?.close();
    } catch {
      // The read error is the one callers handle.
    }
  }
}
