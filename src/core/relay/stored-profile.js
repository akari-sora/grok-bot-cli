import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

// Same cap as relay state diskBytes. Listing must not read a larger file into memory.
export const MAX_STORED_PROFILE_BYTES = 64 * 1024 * 1024;

export function relayProfileMismatchError() {
  return new Error(
    "Relay profile mismatch. This directory was written for a different profile and old bindings are not adopted. With the old version, run `gbot codex bridge stop --worker` before upgrading; that version's `bridge status` includes worker.pid. A pinned GROK_BOT_RELAY_DIR keeps the same socket path, so a still-running old worker is reached on that socket and rejects this hello. Stop the process that has the directory's control.sock or worker.lock open (for example `lsof -t <dir>/worker.lock`), then move or rename the directory, or choose a new GROK_BOT_RELAY_DIR, and bind again. Only the default directory's socket path changes, because it is derived from the profile hash; its old state stays in ~/.grok-bot-cli/relay/<old hash>.",
  );
}

function lastStoredProfile(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  let last = null;
  // Do not require the following key. Canonical JSON currently places "records"
  // after "profile", but the initial document lists "targets" next. A runtime
  // that stops sorting keys must still yield the stored profile.
  for (const match of text.matchAll(/"profile":"([^"\\]{1,512})"/g)) last = match[1];
  return last;
}

/** Profile recorded in this directory's state file, without opening node:sqlite. */
export async function readStoredRelayProfile(dir) {
  let profile = null;
  for (const name of ["relay.sqlite", "relay.sqlite-wal"]) {
    const file = join(dir, name);
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > MAX_STORED_PROFILE_BYTES) throw new Error("Relay storage capacity exceeded");
    const found = lastStoredProfile(await readFile(file));
    if (found) profile = found;
  }
  return profile;
}
