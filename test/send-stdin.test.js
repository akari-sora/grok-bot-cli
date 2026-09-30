import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readStdinMessage } from "../src/core/stdin-message.js";

function stdinFrom(...chunks) {
  return Readable.from(chunks);
}

test("readStdinMessage preserves exact UTF-8 text, including flag-looking lines", async () => {
  const message = await readStdinMessage(stdinFrom(Buffer.from("第一行\n--json\n--files\n最後一行", "utf8")));
  assert.equal(message, "第一行\n--json\n--files\n最後一行");
});

test("readStdinMessage accepts exactly 64 KiB", async () => {
  const message = await readStdinMessage(stdinFrom(Buffer.alloc(64 * 1024, 0x61)));
  assert.equal(message.length, 64 * 1024);
});

for (const [name, chunks, pattern] of [
  ["empty input", [], /stdin message must not be empty/i],
  ["invalid UTF-8", [Buffer.from([0xc3, 0x28])], /valid UTF-8/i],
  ["NUL byte", [Buffer.from("hello\0world")], /NUL/i],
  ["leading whitespace", [Buffer.from(" message")], /surrounding whitespace/i],
  ["trailing whitespace", [Buffer.from("message\n")], /surrounding whitespace/i],
  ["oversized input", [Buffer.alloc(64 * 1024 + 1, 0x61)], /64 KiB/i],
]) {
  test(`readStdinMessage rejects ${name}`, async () => {
    await assert.rejects(readStdinMessage(stdinFrom(...chunks)), pattern);
  });
}
