/** Read-only source adapter. Auth and roster selection stay with the existing gbot backend. */
import { openBackend } from './commands.js';
import { GATEWAY_TIMEOUT_MS, backendRead, connectGateway, gatewayMaxResponseBytes, hasBackend } from './gateway.js';
import { requestHeaders } from './headers.js';
import { normalizeTranscript } from './transcript.js';
import { assertAllowedCredentialUrl } from './url-policy.js';
import { MigrationError } from './migration.js';

/**
 * listSkills intentionally strips bodies. This narrowly scoped reader uses the same URL/header
 * policy, redirect refusal, response cap and deadline, but never calls a mutation or send RPC.
 * No new undocumented endpoint, pagination parameter or model prompt is invented here.
 */
export async function readMigrationWorkflows(session, agentId) {
  if (typeof agentId !== 'string' || !agentId.trim()) throw new MigrationError('A workflow owner id is required.');
  const base = assertAllowedCredentialUrl(session.gatewayUrl, { kind: 'gateway' }).replace(/\/$/, '');
  const response = await fetch(base + '/api/getAgentWorkflows', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    headers: requestHeaders(session), body: JSON.stringify({ id: agentId }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MigrationError(`Workflow read failed (HTTP ${response.status}); no response body was recorded.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MigrationError('Workflow read returned no body.');
  const chunks = [];
  const cap = gatewayMaxResponseBytes();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new MigrationError('Workflow response exceeds the configured read budget.');
      chunks.push(Buffer.from(value));
    }
  } finally { try { await reader.cancel(); } catch { /* closed or aborted */ } }
  let raw;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new MigrationError('Workflow response is not valid UTF-8 JSON.'); }
  const rows = Array.isArray(raw) ? raw : raw?.workflows;
  if (!Array.isArray(rows)) throw new MigrationError('Unsupported workflow response shape.');
  return rows.map((w) => {
    if (!w || typeof w !== 'object' || Array.isArray(w) ||
        !(typeof w.id === 'string' || Number.isSafeInteger(w.id))) throw new MigrationError('Invalid workflow record.');
    // Missing fields stay missing, never fabricated from a name or model-generated summary.
    return {
      id: String(w.id), name: w.name ?? '', description: w.description ?? '', source: w.source ?? 'unknown',
      body: typeof w.body === 'string' ? w.body : null,
      schedule: typeof w.trigger?.schedule === 'string' ? w.trigger.schedule : null,
    };
  });
}

/** @param {{account?: string, dir?: string, files?: boolean}} [options] */
export async function openMigrationSource({ account, dir, files = false } = {}) {
  const local = files || Boolean(dir);
  if (local && account) throw new MigrationError('--account cannot be combined with --files or --dir.');
  // A gateway override wins over --account in legacy gbot. Migration must not mislabel that account.
  if (account && process.env.GROK_BOT_GATEWAY_URL && process.env.GROK_BOT_GATEWAY_TOKEN) {
    throw new MigrationError('Remove gateway overrides before selecting a migration account.');
  }
  const backend = await openBackend({ account, root: dir, files: local, gateway: !local });
  const records = await backend.list();
  return {
    mode: backend.kind, records,
    transcript: async (agentId, limit) => {
      const out = await backend.transcript(agentId, limit);
      const normalized = normalizeTranscript(out);
      if (normalized.target.id !== agentId) throw new MigrationError('Transcript owner does not match the requested agent.');
      const entries = Array.isArray(out.transcript) ? out.transcript : out.transcript?.entries ?? out.transcript?.messages ?? out.transcript?.items;
      return normalized.messages.map((message, i) => {
        const raw = entries?.[i];
        const value = raw?.timestamp ?? raw?.createdAt ?? raw?.timestampMs;
        return { ...message, timestamp: typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null };
      });
    },
    workflows: async (agentId) => {
      if (backend.kind !== 'gateway') throw new MigrationError('Workflow reads require the live gateway.');
      return readMigrationWorkflows(backend.session, agentId);
    },
  };
}

/**
 * Live, read-only IO for captureBot: allowlisted backend reads, presigned store reads and the
 * box workflow reader. The session never leaves this object.
 * @param {{account?: string, onProgress?: (text: string) => void}} [options]
 */
export async function openLiveCapture({ account, onProgress } = {}) {
  if (account && process.env.GROK_BOT_GATEWAY_URL && process.env.GROK_BOT_GATEWAY_TOKEN) {
    throw new MigrationError('Remove gateway overrides before selecting a migration account.');
  }
  const session = await connectGateway({ account });
  if (!hasBackend(session)) throw new MigrationError('This login has no Grok Bot access token; full capture needs the backend (Grok Bot 0.78+ app login).');
  const rpc = (name, body) => backendRead(session, name, body);
  const presignMany = async (relPaths) => {
    const r = await rpc('PresignSandBoxStoreReads', { relPaths });
    return new Map((r?.instructions ?? []).map((i) => [i.relPath, i.url]));
  };
  return {
    rpc,
    presignMany,
    presign: async (relPath) => {
      const url = (await presignMany([relPath])).get(relPath);
      if (!url) throw new MigrationError('The store did not presign ' + relPath + '.');
      return url;
    },
    fetchImpl: fetch,
    workflows: (agentId) => readMigrationWorkflows(session, agentId),
    onProgress,
  };
}
