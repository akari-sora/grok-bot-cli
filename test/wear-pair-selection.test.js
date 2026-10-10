import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadGrokBotGatewaySelection } from "../src/core/app-session.js";
import { ENTRY_A, ENTRY_B, SECRETS, descriptor, writeDescriptor } from "./helpers/wear-pair-fixture.js";

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "gbot-wear-selection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function counting(password = SECRETS.password) {
  const calls = { count: 0 };
  return {
    calls,
    getKeychainPassword: () => {
      calls.count += 1;
      return password;
    },
  };
}

const load = (dir, options = {}) => loadGrokBotGatewaySelection({ platform: "darwin", home: dir, env: {}, ...options });

test("one saved login is selected with its id, label and session", (t) => {
  const dir = home(t);
  writeDescriptor(dir, { [ENTRY_A]: descriptor() });
  const keychain = counting();
  const selection = load(dir, keychain);
  assert.deepEqual(selection, {
    id: ENTRY_A,
    label: "fake-wear@example.com",
    session: {
      gatewayUrl: `https://${SECRETS.host}`,
      gatewayToken: SECRETS.token,
      headers: { "X-Anyrun-Network-Token": SECRETS.route },
    },
  });
  assert.equal(keychain.calls.count, 1);
});

test("several logins: one decrypt pass, the Keychain password is read once", (t) => {
  const dir = home(t);
  writeDescriptor(dir, {
    [ENTRY_A]: descriptor(),
    [ENTRY_B]: descriptor({ email: "fake-second@example.com", token: "fake-second-token" }),
    "fake-third": descriptor({ email: "fake-third@example.com" }),
  });
  const keychain = counting();
  const selection = load(dir, { ...keychain, account: "fake-second@example.com" });
  assert.equal(selection.id, ENTRY_B);
  assert.equal(selection.session.gatewayToken, "fake-second-token");
  assert.equal(keychain.calls.count, 1);
});

test("several logins need --account; GBOT_ACCOUNT is ignored and not suggested", (t) => {
  const dir = home(t);
  writeDescriptor(dir, {
    [ENTRY_A]: descriptor(),
    [ENTRY_B]: descriptor({ email: "fake-second@example.com" }),
  });
  for (const env of [{}, { GBOT_ACCOUNT: "fake-second@example.com" }]) {
    assert.throws(
      () => load(dir, { ...counting(), env }),
      (error) => {
        assert.equal(error.code, "AMBIGUOUS_ENTRIES");
        assert.deepEqual(error.logins, [
          { label: "fake-wear@example.com", lastSaved: false },
          { label: "fake-second@example.com", lastSaved: true },
        ]);
        assert.match(error.message, /--account <label>/);
        assert.doesNotMatch(error.message, /GBOT_ACCOUNT/);
        assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), new RegExp(`${SECRETS.token}|${SECRETS.route}|${SECRETS.password}`));
        return true;
      },
    );
  }
});

test("--account matches a label case-insensitively for e-mails, an id, or a unique id prefix", (t) => {
  const dir = home(t);
  writeDescriptor(dir, {
    [ENTRY_A]: descriptor(),
    [ENTRY_B]: descriptor({ email: "fake-second@example.com" }),
  });
  assert.equal(load(dir, { ...counting(), account: "FAKE-WEAR@example.com" }).id, ENTRY_A);
  assert.equal(load(dir, { ...counting(), account: ENTRY_B }).id, ENTRY_B);
  assert.equal(load(dir, { ...counting(), account: " 9c8e1f27 " }).id, ENTRY_B);
  assert.throws(() => load(dir, { ...counting(), account: "fake-nobody" }), (error) => {
    assert.equal(error.code, "UNKNOWN_ACCOUNT");
    assert.equal(error.logins.length, 2);
    assert.doesNotMatch(error.message, /GBOT_ACCOUNT|fake-nobody/);
    return true;
  });
});

test("when no saved login can be decrypted the error says so (Keychain), asked once, listing nothing", (t) => {
  const dir = home(t);
  writeDescriptor(dir, {
    [ENTRY_A]: descriptor(),
    [ENTRY_B]: descriptor({ email: "fake-second@example.com" }),
  });
  let calls = 0;
  const getKeychainPassword = () => {
    calls += 1;
    throw new Error("fake keychain denied");
  };
  for (const account of [ENTRY_A, "fake-nobody", undefined]) {
    assert.throws(() => load(dir, { getKeychainPassword, account }), (error) => {
      assert.equal(error.code, "UNREADABLE_ENTRIES");
      assert.match(error.message, /Keychain/);
      assert.equal(error.logins, undefined, "no ids are listed");
      assert.doesNotMatch(error.message, new RegExp(`${ENTRY_A}|${ENTRY_B}|fake keychain denied`));
      return true;
    });
  }
  assert.equal(calls, 3, "once per call, not once per entry");
  assert.throws(() => load(dir, { getKeychainPassword: () => "fake-wrong-password" }), (error) => error.code === "UNREADABLE_ENTRIES");
});

test("one unreadable login among readable ones is unusable only when it is selected", (t) => {
  const dir = home(t);
  const path = writeDescriptor(dir, {
    [ENTRY_A]: descriptor(),
    [ENTRY_B]: descriptor({ email: "fake-second@example.com" }),
  });
  const wrapped = JSON.parse(readFileSync(path, "utf8"));
  wrapped.entries[ENTRY_B].encrypted = Buffer.from("v10fake-garbage").toString("base64");
  writeFileSync(path, JSON.stringify(wrapped));
  assert.equal(load(dir, { ...counting(), account: ENTRY_A }).id, ENTRY_A);
  assert.throws(() => load(dir, { ...counting(), account: ENTRY_B }), (error) => error.code === "UNUSABLE_SESSION");
});

test("a label or id that equals or contains a secret is shown as login <n>", (t) => {
  const dir = home(t);
  writeDescriptor(dir, {
    [ENTRY_A]: descriptor({ email: SECRETS.token }),
    [SECRETS.route]: descriptor({ email: "fake-second@example.com" }),
    "fake-third": descriptor({ displayName: `Pod ${SECRETS.host.toUpperCase()}`, email: undefined }),
    "fake-fourth": descriptor({ email: "fake-fourth@example.com" }),
  });
  assert.throws(() => load(dir, counting()), (error) => {
    assert.deepEqual(error.logins.map((row) => row.label), ["login 1", "fake-second@example.com", "login 3", "fake-fourth@example.com"]);
    for (const secret of [SECRETS.token, SECRETS.route, SECRETS.host]) {
      assert.equal(error.message.toLowerCase().includes(secret.toLowerCase()), false);
    }
    return true;
  });
  const masked = load(dir, { ...counting(), account: "login 1" });
  assert.deepEqual({ id: masked.id, label: masked.label }, { id: ENTRY_A, label: "login 1" });
  assert.equal(masked.session.gatewayToken, SECRETS.token, "only the shown label changes");
  // The real label still selects; the id that aliases the routing secret is never returned.
  assert.equal(load(dir, { ...counting(), account: SECRETS.token }).label, "login 1");
  const second = load(dir, { ...counting(), account: "fake-second@example.com" });
  assert.deepEqual({ id: second.id, label: second.label }, { id: "login 2", label: "fake-second@example.com" });
  assert.equal(load(dir, { ...counting(), account: "fake-fourth@example.com" }).label, "fake-fourth@example.com");
});

test("incomplete or non-string descriptors are refused; no descriptor is null", (t) => {
  const dir = home(t);
  assert.equal(load(dir, counting()), null);
  writeDescriptor(dir, { [ENTRY_A]: descriptor({ token: 12345 }) });
  assert.throws(() => load(dir, counting()), (error) => error.code === "INCOMPLETE_DESCRIPTOR");
  writeDescriptor(dir, { [ENTRY_A]: descriptor({ baseUrl: "" }) });
  assert.throws(() => load(dir, counting()), (error) => error.code === "INCOMPLETE_DESCRIPTOR");
  writeDescriptor(dir, {});
  assert.throws(() => load(dir, counting()), (error) => error.code === "EMPTY_ENTRIES");
  assert.equal(loadGrokBotGatewaySelection({ platform: "aix", home: dir }), null);
});
