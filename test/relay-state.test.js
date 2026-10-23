import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = () => import("../src/core/relay/state.js");
const target = {
  id: "opaque / target",
  cursor: null,
  baseline: true,
  state: "running",
  reason: null,
  nextPoll: 0,
  failures: 0,
};
test("a non-database file that contains a profile string is corrupt, not a mismatch", async () => {
  const { openRelayState } = await load();
  const { readStoredRelayProfile } = await import("../src/core/relay/stored-profile.js");
  const dir = await mkdtemp(join(tmpdir(), "relay-corrupt-"));
  try {
    await writeFile(join(dir, "relay.sqlite"), Buffer.from('{"version":1,"profile":"legacy-order","targets":{}}'));
    await assert.rejects(readStoredRelayProfile(dir), (error) => {
      assert.equal(error.name, "RelayStorageError");
      assert.equal(error.code, "corrupt");
      assert.doesNotMatch(error.message, /mismatch/);
      return true;
    });
    await assert.rejects(openRelayState({ dir, profile: "other-order" }), (error) => {
      assert.equal(error.code, "corrupt");
      assert.doesNotMatch(error.message, /mismatch|disagrees|could not be opened/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a split profile match later in the state file is not a mismatch", async () => {
  const { openRelayState } = await load();
  const { readStoredRelayProfile } = await import("../src/core/relay/stored-profile.js");
  const dir = await mkdtemp(join(tmpdir(), "relay-page-"));
  const profile = "a".repeat(64);
  let opened;
  try {
    opened = await openRelayState({ dir, profile });
    assert.equal(await readStoredRelayProfile(dir), profile);
    await opened.close();
    opened = null;
    const beforeRead = (await readdir(dir)).sort();
    assert.equal(await readStoredRelayProfile(dir), profile);
    assert.deepEqual((await readdir(dir)).sort(), beforeRead);
    const file = join(dir, "relay.sqlite");
    // The byte scan's last match is this cut-off value (NUL, as in an overflow
    // page pointer). SQLite still has the profile that was committed.
    await appendFile(file, Buffer.concat([
      Buffer.from('"profile":"'),
      Buffer.from("b".repeat(30)),
      Buffer.from([0x00, 0x00, 0x01, 0x02]),
      Buffer.from("b".repeat(34)),
      Buffer.from('"'),
    ]));
    const text = Buffer.from(await readFile(file)).toString("latin1");
    let last = null;
    for (const match of text.matchAll(/"profile":"([^"\\]{1,512})"/g)) last = match[1];
    assert.notEqual(last, profile);
    assert.equal(last.includes("\0"), true);
    assert.equal(await readStoredRelayProfile(dir), profile);
    opened = await openRelayState({ dir, profile });
    assert.equal(opened.read().profile, profile);
    await opened.close();
    opened = null;
    await assert.rejects(openRelayState({ dir, profile: "c".repeat(64) }), (error) => {
      assert.match(error.message, /^Relay profile mismatch/);
      assert.match(error.message, /other than an upgrade/);
      assert.match(error.message, /gbot codex bridge stop --worker/);
      assert.doesNotMatch(error.message, /could not be opened/);
      return true;
    });
  } finally {
    await opened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a locked state file is a typed error and is not read as a profile", async () => {
  const { openRelayState } = await load();
  const { readStoredRelayProfile } = await import("../src/core/relay/stored-profile.js");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "relay-locked-"));
  const profile = "d".repeat(64);
  let opened;
  let holder;
  try {
    opened = await openRelayState({ dir, profile });
    await opened.close();
    opened = null;
    holder = new DatabaseSync(join(dir, "relay.sqlite"));
    holder.exec("PRAGMA locking_mode=EXCLUSIVE");
    holder.exec("BEGIN EXCLUSIVE");
    await assert.rejects(readStoredRelayProfile(dir, { busyTimeoutMs: 200 }), (error) => {
      assert.equal(error.name, "RelayStorageError");
      assert.equal(error.code, "locked");
      assert.doesNotMatch(error.message, /mismatch/);
      return true;
    });
    await assert.rejects(openRelayState({ dir, profile, busyTimeoutMs: 200 }), (error) => {
      assert.equal(error.code, "locked");
      assert.doesNotMatch(error.message, /mismatch/);
      return true;
    });
  } finally {
    holder?.close();
    await opened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("state commits atomically, reopens without replay, and skips unchanged patches", async () => {
  const { openRelayState } = await load();
  const dir = await mkdtemp(join(tmpdir(), "relay-state-"));
  let s;
  try {
    s = await openRelayState({ dir, profile: "test" });
    await s.commit([{ section: "targets", key: target.id, value: target }]);
    const before = await s.inspect();
    await s.commit([{ section: "targets", key: target.id, value: target }]);
    assert.equal((await s.inspect()).headRevision, before.headRevision);
    await s.close();
    s = await openRelayState({ dir, profile: "test" });
    assert.deepEqual(s.read().targets[target.id], target);
    // Windows reports 0o666 regardless of chmod; Unix mode bits are not stored.
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "relay.sqlite"))).mode & 0o777, 0o600);
    }
    await s.close();
    s = null;
    await assert.rejects(openRelayState({ dir, profile: "other" }), (error) => {
      assert.match(error.message, /^Relay profile mismatch/);
      assert.match(error.message, /other than an upgrade/);
      return true;
    });
  } finally {
    await s?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("state refuses symlink database, corruption and capacity without resetting", async () => {
  const { openRelayState } = await load();
  const dir = await mkdtemp(join(tmpdir(), "relay-state-"));
  let s;
  try {
    const file = join(dir, "relay.sqlite");
    await symlink("/tmp", file);
    await assert.rejects(
      openRelayState({ dir, profile: "test" }),
      /regular|symlink/,
    );
    await rm(file);
    await writeFile(file, "broken");
    await assert.rejects(openRelayState({ dir, profile: "test" }));
    assert.equal((await stat(file)).size, 6);
    await rm(file);
    s = await openRelayState({ dir, profile: "test", limits: { targets: 1 } });
    await s.commit([{ section: "targets", key: target.id, value: target }]);
    await assert.rejects(
      s.commit([
        {
          section: "targets",
          key: "second",
          value: { ...target, id: "second" },
        },
      ]),
      /capacity/,
    );
    assert.equal(Object.keys(s.read().targets).length, 1);
  } finally {
    await s?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal compaction stays bounded and unsupported versions fail closed", async () => {
  const { openRelayState } = await load();
  const dir = await mkdtemp(join(tmpdir(), "relay-state-"));
  let s;
  try {
    s = await openRelayState({ dir, profile: "test" });
    for (let i = 0; i < 20; i++)
      await s.commit([
        {
          section: "targets",
          key: target.id,
          value: { ...target, nextPoll: i },
        },
      ]);
    assert.ok((await s.inspect()).records < 8);
    await s.close();
    s = null;
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "relay.sqlite"));
    db.exec("UPDATE agent_state_meta SET schema_version = 999");
    db.close();
    await assert.rejects(
      openRelayState({ dir, profile: "test" }),
      /version|migration|schema/,
    );
  } finally {
    await s?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
