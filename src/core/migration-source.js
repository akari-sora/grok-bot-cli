/**
 * Migration source: the read-only capture IO, and the routine switch `--move-routines` uses after a
 * verified import. Auth and account selection stay with the existing gbot gateway code.
 */
import { backendOnlySession, backendRead, setAutomationEnabled } from './gateway.js';
import { normalizeAutomation } from './migration-capture.js';
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

/**
 * The one write `gbot migrate --move-routines` makes on Grok Bot, separate from the read-only
 * capture and made only after the destination verified: SetGrokBotAgentAutomationEnabled, as the
 * app's Routines toggle. Opened before the import changes anything, so a login that cannot be used
 * stops the import instead of the pause. `setEnabled` resolves the routine as the answer lists it
 * now (normalized like the capture), or null when the answer does not list it.
 * @param {{account?: string}} [options]
 */
export function openRoutineSwitch({ account } = {}) {
  if (account && process.env.GROK_BOT_GATEWAY_URL && process.env.GROK_BOT_GATEWAY_TOKEN) {
    throw new MigrationError('Remove gateway overrides before selecting a migration account.');
  }
  const session = backendOnlySession({ account });
  return {
    setEnabled: async (agentId, automationId, isEnabled) => {
      const data = await setAutomationEnabled(session, { agentId, automationId, isEnabled });
      for (const a of data?.automations ?? []) {
        let record;
        try { record = normalizeAutomation(JSON.parse(a.recordJson)); } catch { continue; }
        if (record.id === automationId) return record;
      }
      return null;
    },
  };
}
