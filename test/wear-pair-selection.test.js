import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

test("a Keychain failure is asked once and reported as an unusable login, not as its message", (t) => {
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
  assert.throws(() => load(dir, { getKeychainPassword, account: ENTRY_A }), (error) => error.code === "UNUSABLE_SESSION");
  assert.equal(calls, 1);
  assert.throws(() => load(dir, { getKeychainPassword: () => "fake-wrong-password", account: ENTRY_A }), (error) => error.code === "UNUSABLE_SESSION");
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
