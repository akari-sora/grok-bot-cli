import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import test from "./helpers/win32-test.js";
import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { relayLocation, relayProfile } from "../src/core/relay/profile.js";
import { runRelayWorker } from "../src/core/relay/worker.js";
import { relayRequest } from "../src/core/relay/control.js";
import { managedOperation } from "../src/core/relay/managed.js";

const env = { CODEX_HOME: "/tmp/test-codex", GROK_BOT_TEST: "1" };
test("profile shares hosts but isolates endpoint, auth overrides and caller restrictions", () => {
  const base = relayProfile(env);
  assert.equal(
    base,
    relayProfile({
      ...env,
      AGENT_BUNDLE_PLUGIN_ROOT: "/other host",
      CODEX_THREAD_ID: "stale",
    }),
  );
  for (const extra of [
    { GROK_BOT_CODEX_THREADS: "thread-1" },
    { GROK_BOT_MAX_HOPS: "2" },
    { GROK_BOT_GATEWAY_TOKEN: "secret" },
    { GROK_BOT_GATEWAY_HEADERS: '{"x-route":"secret"}' },
    { CODEX_APP_SERVER_SOCK: "/other.sock" },
    { GROK_BOT_TEST: "0" },
    { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    { DISPLAY: ":0" },
  ])
    assert.notEqual(base, relayProfile({ ...env, ...extra }));
  assert.equal(
    relayProfile({ ...env, GBOT_ACCOUNT: "work", GBOT_CONFIG: "/tmp/a.json" }, "ab".repeat(32)),
    relayProfile({ ...env, GBOT_ACCOUNT: "work@example.com", GBOT_CONFIG: "/tmp/b.json" }, "ab".repeat(32)),
  );
  assert.ok(
    !relayProfile({ ...env, GROK_BOT_GATEWAY_TOKEN: "secret" }).includes(
      "secret",
    ),
  );
});
test("only socket owner opens engine, profile mismatch refuses, stop closes owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-worker-"));
  const profile = relayProfile(env);
  let opened = 0,
    closed = 0;
  const openEngine = async () => {
    opened++;
    return {
      status: () => ({ state: "running", bindings: [], receipts: [] }),
      tick: async () => {},
      close: async () => {
        closed++;
      },
    };
  };
  const worker = await runRelayWorker({ stateDir, profile, env, openEngine });
  try {
    assert.equal(
      (await relayRequest({ stateDir, profile, env }, "hello", {})).worker
        .state,
      "running",
    );
    await assert.rejects(
      runRelayWorker({ stateDir, profile, env, openEngine }),
      /owner|running|locked/i,
    );
    assert.equal(opened, 1);
    await assert.rejects(
      relayRequest({ stateDir, profile: "other", env }, "hello", {}),
      /profile/i,
    );
    assert.equal(
      (await relayRequest({ stateDir, profile, env }, "status", {})).worker
        .supervised,
      false,
    );
  } finally {
    await worker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
  assert.equal(closed, 1);
});
test("worker rejects symlink lock before opening engine", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-worker-"));
  await symlink("/tmp/missing", join(stateDir, "worker.lock"));
  try {
    await assert.rejects(
      runRelayWorker({
        stateDir,
        profile: relayProfile(env),
        env,
        openEngine: () => {
          throw Error("engine must not open");
        },
      }),
      /symlink|regular/i,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("live control listener without metadata is never unlinked or opened as another engine", async () => {
  const { createServer } = await import("node:net");
  const { lstat } = await import("node:fs/promises");
  const { relayLocation } = await import("../src/core/relay/profile.js");
  const stateDir = await mkdtemp("/tmp/relay-owner-");
  const location = relayLocation({ stateDir, env });
  const server = createServer((s) => s.end());
  await new Promise((r) => server.listen(location.socketPath, r));
  try {
    await assert.rejects(
      runRelayWorker({
        ...location,
        openEngine: () => {
          throw Error("must not open");
        },
      }),
      /listener already running/,
    );
    assert.equal((await lstat(location.socketPath)).isSocket(), true);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("ownership keeps one lock inode across clean restarts and protects SQLite sidecars", async () => {
  const { lstat } = await import("node:fs/promises");
  const stateDir = await mkdtemp("/tmp/relay-inode-");
  const profile = relayProfile(env);
  const openEngine = async () => ({
    status: () => ({}),
    tick: async () => {},
    close: async () => {},
  });
  let worker = await runRelayWorker({ stateDir, profile, env, openEngine });
  try {
    const first = await lstat(join(stateDir, "worker.lock"));
    await worker.close();
    assert.equal((await lstat(join(stateDir, "worker.lock"))).ino, first.ino);
    worker = await runRelayWorker({ stateDir, profile, env, openEngine });
    assert.equal((await lstat(join(stateDir, "worker.lock"))).ino, first.ino);
    await worker.close();
    await symlink("/tmp/foreign-owner", join(stateDir, "worker.lock-journal"));
    await assert.rejects(
      runRelayWorker({ stateDir, profile, env, openEngine }),
      /symlink|regular/,
    );
  } finally {
    await worker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("private control protocol preserves UTF-8 text across socket chunks", async () => {
  const { connect } = await import("node:net");
  const stateDir = await mkdtemp("/tmp/relay-utf8-");
  const profile = relayProfile(env);
  const worker = await runRelayWorker({
    stateDir,
    profile,
    env,
    openEngine: async () => ({
      tick: async () => {},
      close: async () => {},
      sendToGrok: async (input) => ({ text: input.message }),
    }),
  });
  try {
    const text = "hello 🛰️ 世界";
    const request = Buffer.from(
      JSON.stringify({
        version: 1,
        profile,
        requestId: "split-utf8",
        method: "sendToGrok",
        input: { message: text },
      }) + "\n",
    );
    const split = request.indexOf(Buffer.from("🛰")) + 1;
    const out = await new Promise((resolve, reject) => {
      const socket = connect(worker.location.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (c) => (buffer += c));
      socket.on("end", () => resolve(JSON.parse(buffer)));
      socket.on("connect", () => {
        socket.write(request.subarray(0, split));
        setTimeout(() => socket.end(request.subarray(split)), 20);
      });
    });
    assert.equal(out.result.text, text);
  } finally {
    await worker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("short socket fallback refuses a symlinked parent directory", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { claimRelayOwner } = await import("../src/core/relay/ownership.js");
  const root = await mkdtemp("/tmp/relay-parent-");
  await mkdir(join(root, "actual"));
  await symlink(join(root, "actual"), join(root, "alias"));
  try {
    await assert.rejects(
      claimRelayOwner({
        stateDir: join(root, "state"),
        socketDir: join(root, "alias", "child"),
        socketPath: join(root, "alias", "child", "control.sock"),
      }),
      /symlink|owned/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge stop and status still see workers when login resolution fails", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "relay-login-fail-"));
  const descriptor = grokBotGatewayDescriptorPath(home, process.platform, {});
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: "not-used" }));
  const root = join(home, ".grok-bot-cli", "relay");
  const dirA = join(root, "worker-a");
  const dirB = join(root, "worker-b");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  const scopeA = "1".repeat(64);
  const scopeB = "2".repeat(64);
  const profileA = "a".repeat(64);
  const profileB = "b".repeat(64);
  const closed = { a: 0, b: 0 };
  const openEngine = (which) => async () => ({
    status: () => ({ state: "running", bindings: [], receipts: [] }),
    tick: async () => {},
    close: async () => { closed[which] += 1; },
  });
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
  };
  const workerA = await runRelayWorker({
    stateDir: dirA,
    profile: profileA,
    accountScope: scopeA,
    env,
    openEngine: openEngine("a"),
  });
  const workerB = await runRelayWorker({
    stateDir: dirB,
    profile: profileB,
    accountScope: scopeB,
    env,
    openEngine: openEngine("b"),
  });
  t.after(async () => {
    await workerA.close().catch(() => {});
    await workerB.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  await assert.rejects(
    managedOperation("startBinding", { grokTarget: "target", codexThreadId: "thread" }, { env }),
    (error) => error.code === "UNSUPPORTED_VERSION",
  );
  assert.equal(closed.a, 0);
  assert.equal(closed.b, 0);
  const listed = await managedOperation("status", {}, { env });
  assert.equal(listed.accountResolution, "failed");
  assert.equal(listed.selected, null);
  assert.deepEqual(listed.directories.map((row) => row.stateDir).sort(), [dirA, dirB].sort());
  assert.equal(listed.directories.find((row) => row.stateDir === dirA).worker.state, "running");
  assert.equal(listed.directories.find((row) => row.stateDir === dirB).profile, profileB);
  await assert.rejects(
    managedOperation("stop", { worker: true }, { env }),
    /will not choose/,
  );
  await assert.rejects(
    managedOperation("stop", { worker: true }, { env: { ...env, GBOT_ACCOUNT_SCOPE: "not-a-scope" } }),
    (error) => error.code === "INVALID_ACCOUNT_SCOPE",
  );
  assert.equal(closed.a, 0);
  assert.equal(closed.b, 0);
  const one = await managedOperation("status", {}, { env: { ...env, GROK_BOT_RELAY_DIR: dirA } });
  assert.equal(one.stateDir, dirA);
  assert.equal(one.worker.state, "running");
  assert.equal(one.worker.profile, profileA);
  assert.equal(one.accountResolution, "failed");
  assert.equal(Object.hasOwn(one, "directories"), false);
  z.record(z.string(), z.json()).parse(one);
  const stopped = await managedOperation("stop", { worker: true }, { env: { ...env, GROK_BOT_RELAY_DIR: dirA } });
  assert.equal(Object.hasOwn(stopped, "directories"), false);
  z.record(z.string(), z.json()).parse(stopped);
  await workerA.closed;
  assert.equal(closed.a, 1);
  assert.equal(closed.b, 0);
  assert.equal(
    (await relayRequest({ stateDir: dirB, profile: profileB, accountScope: scopeB, env }, "hello", {})).worker.state,
    "running",
  );
});

test("managed status and start surface Relay profile mismatch for a stopped pinned directory", async () => {
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const home = await mkdtemp(join(tmpdir(), "relay-mismatch-home-"));
  const dir = await mkdtemp(join(tmpdir(), "relay-mismatch-dir-"));
  const gateway = {
    resolve: async (ref) => ({ id: ref, name: "Fixture" }),
    tail: async () => ({ entries: [] }),
    send: async () => ({ delivery: "rejected" }),
  };
  const legacy = await openRelayEngine({
    stateDir: dir,
    profile: "legacy-pinned-profile",
    env: { CODEX_HOME: join(home, "codex"), GROK_BOT_TEST: "1" },
    gateway,
    clock: () => 1,
  });
  await legacy.close();
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GROK_BOT_RELAY_DIR: dir,
    GBOT_ACCOUNT_SCOPE: "a".repeat(64),
  };
  try {
    await assert.rejects(managedOperation("status", {}, { env }), (error) => {
      assert.match(error.message, /^Relay profile mismatch/);
      assert.match(error.message, /other than an upgrade/);
      assert.match(error.message, /account or environment/);
      assert.match(error.message, /gbot codex bridge stop --worker/);
      assert.match(error.message, /worker\.pid/);
      assert.match(error.message, /same socket path/);
      assert.match(error.message, /lsof -t <dir>\/worker\.lock/);
      assert.doesNotMatch(error.message, /startup failed or timed out/);
      assert.doesNotMatch(error.message, /Worker is not running/);
      return true;
    });
    await assert.rejects(
      managedOperation("startBinding", { grokTarget: "target", codexThreadId: "thread" }, { env }),
      /Relay profile mismatch/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a still-running worker that replies Relay profile mismatch shows the upgrade steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-old-worker-"));
  const profile = "e".repeat(64);
  const caller = { HOME: dir, USERPROFILE: dir, CODEX_HOME: join(dir, "codex"), GROK_BOT_TEST: "1" };
  const location = relayLocation({ stateDir: dir, profile, env: caller });
  await mkdir(dirname(location.socketPath), { recursive: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      socket.end(JSON.stringify({
        version: 1,
        profile,
        requestId: request.requestId,
        error: "Relay profile mismatch",
      }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(location.socketPath, resolve);
  });
  try {
    await assert.rejects(relayRequest({ stateDir: dir, profile, env: caller }, "hello", {}), (error) => {
      assert.match(error.message, /^Relay profile mismatch/);
      assert.match(error.message, /other than an upgrade/);
      assert.match(error.message, /gbot codex bridge stop --worker/);
      assert.match(error.message, /lsof -t <dir>\/worker\.lock/);
      assert.notEqual(error.message, "Relay profile mismatch");
      return true;
    });
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
    if (location.socketDir !== dir) await rm(location.socketDir, { recursive: true, force: true });
  }
});

test("worker start removes a leftover profile temp before the engine opens", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-profile-tmp-"));
  const stale = join(stateDir, "profile.4242.deadbeef.tmp");
  await writeFile(stale, "stale");
  try {
    await assert.rejects(runRelayWorker({
      stateDir,
      profile: "f".repeat(64),
      env,
      openEngine: async () => {
        throw new Error("synthetic engine failure");
      },
    }), /synthetic engine failure/);
    await assert.rejects(access(stale), (error) => error.code === "ENOENT");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a profile rewrite keeps the previous file when the directory cannot create a replacement", async () => {
  const { readRelayProfileFile, writeRelayProfileFile } = await import("../src/core/relay/profile.js");
  const dir = await mkdtemp(join(tmpdir(), "relay-profile-write-"));
  const previous = "a".repeat(64);
  try {
    await writeRelayProfileFile(dir, previous);
    await chmod(dir, 0o555);
    await assert.rejects(writeRelayProfileFile(dir, "b".repeat(64)));
    await chmod(dir, 0o700);
    assert.equal(await readRelayProfileFile(dir), previous);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("one unreadable relay directory does not fail the status list", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-unreadable-"));
  const descriptor = grokBotGatewayDescriptorPath(home, process.platform, {});
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: "not-used" }));
  const root = join(home, ".grok-bot-cli", "relay");
  const good = join(root, "good");
  const bad = join(root, "bad");
  await mkdir(good, { recursive: true });
  await mkdir(bad, { recursive: true });
  await writeFile(join(good, "profile"), "ab".repeat(32), { mode: 0o600 });
  await writeFile(join(bad, "profile"), "", { mode: 0o600 });
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
  };
  try {
    const listed = await managedOperation("status", {}, { env });
    const goodRow = listed.directories.find((row) => row.stateDir === good);
    const badRow = listed.directories.find((row) => row.stateDir === bad);
    assert.equal(goodRow.profile, "ab".repeat(32));
    assert.equal(goodRow.worker.state, "stopped");
    assert.equal(badRow.profile, null);
    assert.equal(badRow.worker.state, "unreadable");
    assert.match(badRow.reason, /invalid/i);
    await assert.rejects(
      managedOperation("stop", { worker: true }, { env: { ...env, GROK_BOT_RELAY_DIR: bad } }),
      /invalid/i,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("relay files that together exceed the storage cap are unreadable", async () => {
  const cap = 64 * 1024 * 1024;
  const part = Math.floor(cap / 2) + 1;
  const home = await mkdtemp(join(tmpdir(), "relay-sum-cap-"));
  const descriptor = grokBotGatewayDescriptorPath(home, process.platform, {});
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: "not-used" }));
  const dir = join(home, ".grok-bot-cli", "relay", "split");
  await mkdir(dir, { recursive: true });
  for (const name of ["relay.sqlite", "relay.sqlite-wal"]) {
    const handle = await open(join(dir, name), "w");
    await handle.truncate(part);
    await handle.close();
  }
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
  };
  try {
    const listed = await managedOperation("status", {}, { env });
    const row = listed.directories.find((item) => item.stateDir === dir);
    assert.equal(row.worker.state, "unreadable");
    assert.match(row.reason, /capacity/);
    assert.doesNotMatch(row.reason, /mismatch/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a state file over the storage cap is unreadable and is not loaded", async () => {
  const { RELAY_DISK_BYTES } = await import("../src/core/relay/stored-profile.js");
  const scanCap = RELAY_DISK_BYTES;
  const home = await mkdtemp(join(tmpdir(), "relay-huge-"));
  const descriptor = grokBotGatewayDescriptorPath(home, process.platform, {});
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: "not-used" }));
  const huge = join(home, ".grok-bot-cli", "relay", "huge");
  await mkdir(huge, { recursive: true });
  const handle = await open(join(huge, "relay.sqlite"), "w");
  await handle.truncate(scanCap + 1);
  await handle.close();
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
  };
  try {
    const listed = await managedOperation("status", {}, { env });
    const row = listed.directories.find((item) => item.stateDir === huge);
    assert.equal(row.worker.state, "unreadable");
    assert.match(row.reason, /capacity/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a corrupt state file is listed as unreadable and is not treated as a profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-corrupt-list-"));
  const descriptor = grokBotGatewayDescriptorPath(home, process.platform, {});
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: "not-used" }));
  const dir = join(home, ".grok-bot-cli", "relay", "bad");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "relay.sqlite"), Buffer.from(`noise "profile":"${"ab".repeat(32)}"`));
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
  };
  try {
    const listed = await managedOperation("status", {}, { env });
    const row = listed.directories.find((item) => item.stateDir === dir);
    assert.equal(row.worker.state, "unreadable");
    assert.match(row.reason, /corrupt/);
    assert.doesNotMatch(row.reason, /mismatch/);
    assert.equal(row.profile, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status reads the stored profile from sqlite when the profile file is absent", async () => {
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const { access } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "relay-sqlite-profile-"));
  const descriptor = grokBotGatewayDescriptorPath(home, process.platform, {});
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: "not-used" }));
  const dir = join(home, "pinned-relay");
  await mkdir(dir, { recursive: true });
  const gateway = {
    resolve: async (ref) => ({ id: ref, name: "Fixture" }),
    tail: async () => ({ entries: [] }),
    send: async () => ({ delivery: "rejected" }),
  };
  const engine = await openRelayEngine({
    stateDir: dir,
    profile: "stored-only-profile",
    env: { CODEX_HOME: join(home, "codex"), GROK_BOT_TEST: "1" },
    gateway,
    clock: () => 1,
  });
  await engine.close();
  await assert.rejects(access(join(dir, "profile")), (error) => error.code === "ENOENT");
  const env = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, "codex"),
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
    GROK_BOT_RELAY_DIR: dir,
  };
  try {
    const status = await managedOperation("status", {}, { env });
    assert.equal(status.worker.profile, "stored-only-profile");
    assert.equal(status.worker.state, "stopped");
    assert.equal(status.accountResolution, "failed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
