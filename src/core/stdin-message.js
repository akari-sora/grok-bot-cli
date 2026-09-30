import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

import { StoreError } from "./store.js";

export const MAX_STDIN_MESSAGE_BYTES = 64 * 1024;

export async function readCommandStdin() {
  const file = process.env.GBOT_STDIN_FILE;
  if (typeof file === "string" && file) {
    return readStdinMessage(Readable.from([readFileSync(file)]));
  }
  return readStdinMessage(process.stdin);
}

export async function readStdinMessage(stdin) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_STDIN_MESSAGE_BYTES) {
      throw new StoreError("stdin message must be at most 64 KiB.");
    }
    chunks.push(bytes);
  }
  if (byteLength === 0) throw new StoreError("stdin message must not be empty.");

  let message;
  try {
    message = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new StoreError("stdin message must be valid UTF-8.");
  }
  if (message.includes("\0")) throw new StoreError("stdin message must not contain a NUL byte.");
  if (message.trim() !== message) {
    throw new StoreError("stdin message must not have surrounding whitespace.");
  }
  return message;
}
