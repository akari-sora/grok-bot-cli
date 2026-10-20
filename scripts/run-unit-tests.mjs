import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Enumerate tests portably without relying on shell glob expansion.
// Windows runs this same list. Unix-only files import test/helpers/win32-test.js
// and skip each test with a reason instead of being dropped here.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name));
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  // Loopback-only credential URLs (src/core/url-policy.js testMode): a test can never reach a live gateway.
  // The gateway read cap must not come from the developer's shell.
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GBOT_MAX_RESPONSE_BYTES")), GROK_BOT_TEST: "1" },
  stdio: "inherit",
});
process.exit(result.status === null ? 1 : result.status);
