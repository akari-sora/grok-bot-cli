// Preloaded with NODE_OPTIONS=--import by wear-pair-signals.test.js: records that the gbot worker process
// (dist/bin/gbot.mjs) started, so a test can prove the wrapper refused before spawning it.
import { appendFileSync } from "node:fs";

const file = process.env.WEAR_SENTINEL_FILE;
if (file && /[\\/]dist[\\/]bin[\\/]gbot\.mjs$/.test(process.argv[1] ?? "")) appendFileSync(file, "worker started\n");
