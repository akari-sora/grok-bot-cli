import test from "node:test";

// Suites that need Unix sockets, shebang executables, or process.getuid().
// Windows still loads these files; each test is skipped with UNIX_ONLY_SKIP_REASON.
export const UNIX_ONLY_SKIP_REASON =
  "Unix sockets and Codex routes are unsupported on win32";

export const UNIX_ONLY_TEST_FILES = [
  "test/claude-channel.test.js",
  "test/codex-bridge.test.js",
  "test/codex-conversation.test.js",
  "test/codex-session.test.js",
  "test/codex-surfaces.test.js",
  "test/relay-auth-recovery.test.js",
  "test/relay-engine.test.js",
  "test/relay-gateway-lifecycle.test.js",
  "test/relay-lifecycle.test.js",
  "test/relay-surfaces.test.js",
  "test/relay-worker.test.js",
];

// GBOT_UNIT_SKIP_UNIX_ONLY is set only by the collection test so macOS can
// prove the Windows skip path. CI does not set it.
export function shouldSkipUnixOnlyTests(env = process.env, platform = process.platform) {
  return platform === "win32" || env.GBOT_UNIT_SKIP_UNIX_ONLY === "1";
}

function skippedTest(name, options, fn) {
  if (typeof name === "function") return test({ skip: UNIX_ONLY_SKIP_REASON }, name);
  if (name && typeof name === "object") {
    return test(
      { ...name, skip: typeof name.skip === "string" && name.skip ? name.skip : UNIX_ONLY_SKIP_REASON },
      options,
    );
  }
  if (typeof options === "function" || options === undefined) {
    return test(name, { skip: UNIX_ONLY_SKIP_REASON }, options ?? (() => {}));
  }
  const skip = typeof options.skip === "string" && options.skip ? options.skip : UNIX_ONLY_SKIP_REASON;
  return test(name, { ...options, skip }, fn ?? (() => {}));
}

export default shouldSkipUnixOnlyTests() ? skippedTest : test;
