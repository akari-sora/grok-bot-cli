// One test-mode secret-store policy for gateway sessions, `gbot wake`, and `gbot wear pair`.
// Outside test mode the caller keeps the real Keychain, secret-tool, or DPAPI defaults.
// In test mode the real store is never consulted. A fixture password is accepted only when
// GROK_BOT_TEST is exactly `1` (not `true` or `yes`).

export function isTestMode(env = process.env) {
  const raw = String(env.GROK_BOT_TEST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || env.NODE_ENV === "test";
}

export function secretStoreOffMessage(env = process.env) {
  if (!isTestMode(env)) return "";
  if (env.GROK_BOT_TEST === "1" && env.GBOT_TEST_KEYCHAIN_PASSWORD) return "";
  const raw = String(env.GROK_BOT_TEST ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes"
    ? " GROK_BOT_TEST is set, so gbot does not read the Keychain or secret store (test mode)."
    : " NODE_ENV=test is set, so gbot does not read the Keychain or secret store (test mode); unset NODE_ENV to pair.";
}

export function secretStoreOptions(env = process.env) {
  if (!isTestMode(env)) return {};
  const fixture = env.GROK_BOT_TEST === "1" ? env.GBOT_TEST_KEYCHAIN_PASSWORD : undefined;
  const password = typeof fixture === "string" && fixture ? fixture : "";
  return {
    getKeychainPassword() {
      if (password) return password;
      throw new Error("The OS secret store is disabled in test mode.");
    },
    unprotectData() {
      throw new Error("The OS secret store is disabled in test mode.");
    },
  };
}
