import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

function lastStoredProfile(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  let last = null;
  for (const match of text.matchAll(/"profile":"([^"\\]{1,512})","records":/g)) last = match[1];
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
    const found = lastStoredProfile(await readFile(file));
    if (found) profile = found;
  }
  return profile;
}
