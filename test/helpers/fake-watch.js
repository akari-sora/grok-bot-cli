// Test-only JavaScript port of the watch side of GBWP/1 (grok-bot-watch: core/pairing PairingServer.kt and
// Gbwp1.kt): one code, one listener on loopback, at most one handshake. Deadlines are absolute and enforced by
// closing the socket. Behaviour switches let tests play a tampering or broken watch. Never used by the CLI.
import crypto from "node:crypto";
import net from "node:net";

import {
  SIZES,
  constantTimeEqual,
  deriveKeys,
  frame,
  isValidPublicKey,
  preflightSession,
  tagAck,
  tagComputer,
  tagWatch,
  transcriptHash,
} from "../../src/core/wear-pair.js";

const MAGIC = Buffer.from("GBWP", "ascii");

/** Collects bytes from one socket and hands out frames; every wait has an absolute deadline. */
class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.wake = null;
    this.received = 0;
    socket.on("data", (chunk) => {
      this.received += chunk.length;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });
    const end = () => {
      this.closed = true;
      this.wake?.();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  /** A frame whose body length is within min..max, or null (bad length, closed, or deadline -> socket closed). */
  readFrame(min, max, ms) {
    return new Promise((resolve) => {
      let timer;
      const finish = (body) => {
        clearTimeout(timer);
        this.wake = null;
        resolve(body);
      };
      const check = () => {
        if (this.buffer.length >= 2) {
          const length = this.buffer.readUInt16BE(0);
          if (length === 0 || length > SIZES.maxFrame || length < min || length > max) return finish(null);
          if (this.buffer.length >= 2 + length) {
            const body = Buffer.from(this.buffer.subarray(2, 2 + length));
            this.buffer = this.buffer.subarray(2 + length);
            return finish(body);
          }
        }
        if (this.closed) return finish(null);
        return undefined;
      };
      timer = setTimeout(() => {
        this.socket.destroy();
        finish(null);
      }, ms);
      this.wake = check;
      check();
    });
  }

  write(bytes, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        resolve(false);
      }, ms);
      this.socket.write(bytes, (error) => {
        clearTimeout(timer);
        resolve(!error);
      });
    });
  }

  /** Resolves once the peer closed (or `ms` passed). */
  waitClosed(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      const check = () => {
        if (!this.closed) return;
        clearTimeout(timer);
        this.wake = null;
        resolve(true);
      };
      this.wake = check;
      check();
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a fake watch on 127.0.0.1. Options:
 * - codeData: the 12 data symbols the watch shows (the computer must type them plus the check symbol);
 * - limits: { preM1Ms, m3Ms, writeMs, attemptMs } (defaults as on the watch: 5 s, 10 s, 5 s, 180 s);
 * - behavior: { tamperM2: "tag" | "nonce" | "key" | "length" | "trailing", silent, trickleMs, omitM4, status,
 *   beforeM2: async () => void } — a forced `status` skips the import check; otherwise the payload is checked with
 *   the watch's import rules (status 0 when accepted, 1 when rejected).
 * Resolves `{ host, port, connections(), result, close() }`; `result` resolves once with
 * `{ outcome, payload?, bytesAfterM2 }`, outcome one of paired | rejected | storage-failed | auth-failed |
 * network-error | timed-out | silent.
 */
export async function startFakeWatch({ codeData, limits = {}, behavior = {} } = {}) {
  const lim = { preM1Ms: 5_000, m3Ms: 10_000, writeMs: 5_000, attemptMs: 180_000, ...limits };
  let connections = 0;
  let busy = false;
  let finished = false;
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const sockets = new Set();
  const server = net.createServer();
  const end = (value) => {
    if (finished) return;
    finished = true;
    server.close();
    resolveResult(value);
  };
  const attemptTimer = setTimeout(() => end({ outcome: "timed-out" }), lim.attemptMs);
  attemptTimer.unref();

  const handshake = async (socket) => {
    const conn = new Conn(socket);
    // PRE-M1: a silent or malformed connection is dropped; the watch keeps listening.
    const m1 = await conn.readFrame(SIZES.m1, SIZES.m1, lim.preM1Ms);
    const computerPublic = m1?.subarray(5, 70);
    if (!m1 || !m1.subarray(0, 4).equals(MAGIC) || m1[4] !== 1 || !isValidPublicKey(computerPublic)) {
      socket.destroy();
      return;
    }
    // BURN: the code is spent before M2 leaves the watch.
    server.close();
    clearTimeout(attemptTimer);
    if (behavior.beforeM2) await behavior.beforeM2();
    if (behavior.silent) {
      await conn.waitClosed(60_000);
      socket.destroy();
      end({ outcome: "silent", bytesAfterM2: 0 });
      return;
    }
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const watchPublic = ecdh.getPublicKey(null, "uncompressed");
    const watchNonce = crypto.randomBytes(SIZES.nonce);
    const th = transcriptHash(m1, watchPublic, watchNonce);
    const raw = ecdh.computeSecret(computerPublic);
    const shared = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
    const keys = deriveKeys(shared, codeData, th);
    let m2 = Buffer.concat([watchPublic, watchNonce, tagWatch(keys, th)]);
    if (behavior.tamperM2 === "tag") m2[m2.length - 1] ^= 0x01;
    if (behavior.tamperM2 === "nonce") m2[70] ^= 0x01;
    if (behavior.tamperM2 === "key") m2[1] ^= 0x01;
    if (behavior.tamperM2 === "length") m2 = m2.subarray(0, SIZES.m2 - 1);
    let wire = frame(m2);
    if (behavior.tamperM2 === "trailing") wire = Buffer.concat([wire, Buffer.from([0x00])]);
    const before = conn.received;
    if (behavior.trickleMs) {
      for (const byte of wire) {
        if (conn.closed) break;
        socket.write(Buffer.from([byte]));
        await sleep(behavior.trickleMs);
      }
    } else if (!(await conn.write(wire, lim.writeMs))) {
      end({ outcome: "network-error", bytesAfterM2: 0 });
      return;
    }
    const m3 = await conn.readFrame(SIZES.m3Overhead + 1, SIZES.m3Overhead + SIZES.maxPayload, lim.m3Ms);
    const bytesAfterM2 = conn.received - before;
    if (!m3) {
      socket.destroy();
      end({ outcome: conn.closed ? "network-error" : "timed-out", bytesAfterM2 });
      return;
    }
    const tagC = m3.subarray(0, 32);
    if (!constantTimeEqual(tagC, tagComputer(keys, th))) {
      socket.destroy();
      end({ outcome: "auth-failed", bytesAfterM2 });
      return;
    }
    let payload;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", keys.enc, m3.subarray(32, 44), { authTagLength: 16 });
      decipher.setAAD(th);
      decipher.setAuthTag(m3.subarray(m3.length - 16));
      payload = Buffer.concat([decipher.update(m3.subarray(44, m3.length - 16)), decipher.final()]).toString("utf8");
    } catch {
      socket.destroy();
      end({ outcome: "auth-failed", bytesAfterM2 });
      return;
    }
    // COMMIT: store (or reject) the payload, then the authenticated receipt.
    let status = behavior.status;
    if (status === undefined) {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }
      status = preflightSession(parsed).ok ? 0 : 1;
    }
    if (!behavior.omitM4) {
      await conn.write(frame(Buffer.concat([Buffer.from([status]), tagAck(keys, th, m3, status)])), lim.writeMs);
    }
    socket.end();
    const outcome = { 0: "paired", 1: "rejected", 2: "storage-failed" }[status] ?? "unknown";
    end({ outcome, payload, bytesAfterM2 });
  };

  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (busy || finished) {
      socket.destroy();
      return;
    }
    busy = true;
    handshake(socket)
      .catch(() => {
        socket.destroy();
        end({ outcome: "network-error" });
      })
      .finally(() => {
        busy = false;
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    host: "127.0.0.1",
    port,
    connections: () => connections,
    result,
    close: () => {
      clearTimeout(attemptTimer);
      for (const socket of sockets) socket.destroy();
      server.close();
      end({ outcome: "closed" });
    },
  };
}

/** A closed loopback port (bound, then released) for unreachable cases. */
export async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
