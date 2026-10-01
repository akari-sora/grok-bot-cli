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

test("readStdinMessage strips a UTF-8 BOM and decodes UTF-16 BOMs from Windows pipes", async () => {
  const utf8 = await readStdinMessage(stdinFrom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")])));
  assert.equal(utf8, "hello");
  const le = await readStdinMessage(stdinFrom(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")])));
  assert.equal(le, "hello");
  const be = await readStdinMessage(stdinFrom(Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from([0x00, 0x68, 0x00, 0x69]),
  ])));
  assert.equal(be, "hi");
  const lines = await readStdinMessage(stdinFrom(Buffer.from("one\r\ntwo", "utf8")));
  assert.equal(lines, "one\r\ntwo");
});

test("readStdinMessage rejects a BOM-only payload and a trailing CRLF", async () => {
  await assert.rejects(readStdinMessage(stdinFrom(Buffer.from([0xef, 0xbb, 0xbf]))), /empty/i);
  await assert.rejects(readStdinMessage(stdinFrom(Buffer.from("message\r\n", "utf8"))), /surrounding whitespace/i);
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
