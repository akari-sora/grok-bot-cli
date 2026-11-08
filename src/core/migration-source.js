/** Read-only migration source. Auth and account selection stay with the existing gbot gateway code. */
import { backendOnlySession, backendRead } from './gateway.js';
import { MigrationError } from './migration.js';

/**
 * Live, read-only IO for captureBot: allowlisted backend reads and presigned store reads. The
 * session is backend-only (no box wake). The session never leaves this object.
 * @param {{account?: string, onProgress?: (text: string) => void}} [options]
 */
export async function openLiveCapture({ account, onProgress } = {}) {
  if (account && process.env.GROK_BOT_GATEWAY_URL && process.env.GROK_BOT_GATEWAY_TOKEN) {
    throw new MigrationError('Remove gateway overrides before selecting a migration account.');
  }
  const session = backendOnlySession({ account });
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
    onProgress,
  };
}
