# Migration toolkit verification — 2026-11-08

> Superseded: this records the earlier limited-snapshot toolkit, which was replaced on 2026-11-08 by the full migration flow in [docs/migration.md](../migration.md). See [2026-11-08-full-migration.md](2026-11-08-full-migration.md).

Timezone: Asia/Taipei. This record separates executed tests from unverified provider/runtime behavior.

## Revision and evidence

- Baseline main: `80874cac80a4d641b96a1dba420f3e0f1fc4b01c`
- Tested code revision: `9637522877dc4210fd2df7c0189fca87334525cc`
- Branch: `feature/migration-toolkit`
- Draft MR: https://gitlab.com/aa22396584/grok-bot-cli/-/merge_requests/13
- Full validation job: https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17837280012
- Separate unit job: https://gitlab.com/aa22396584/grok-bot-cli/-/jobs/17837280009
- Pipeline: https://gitlab.com/aa22396584/grok-bot-cli/-/pipelines/3041009979

The full validation job finished successfully at 2026-11-08 09:13:08 +08:00. A later optional Windows job was explicitly started; its pending status must not be confused with the completed Linux results below. This documentation commit does not change the tested source or tests.

## Executed results

| Check | Environment | Actual result |
| --- | --- | --- |
| `node --test test/migration.test.js test/migration-boundaries.test.js` | Local Linux, Node 22.16.0, dependency-free subset | 57 passed, 0 failed, 0 skipped |
| `npm run validate` | GitLab Linux, Node 22.23.4 | Passed |
| `npm run build` | Same CI job | Passed; public CLI and generated worker built |
| `npm run validate:artifact` | Same CI job | Pinned local schema validation passed; external host validators unavailable |
| `npm run typecheck` | Same CI job | Passed; no suppression or disabled checks |
| `npm run test:unit` | Same CI job, unprivileged `node` user | 871 total: 846 passed, 25 skipped, 0 failed |
| `npm run test:routes` | Same CI job | 96 passed, 0 failed; all 6 files passed |
| `npm run check` | Same CI job | Entire sequence passed, exit 0 |

The 71 newly added migration tests are included in the unit result, not additional to it: 54 core/archive tests, 3 source-boundary tests, 13 source-adapter tests and 1 public-CLI end-to-end fixture test. The local 57 tests are a subset, not 57 additional independent cases.

Existing platform-specific unit skips remain visible in the TAP output. They are not counted as passes. Claude CLI, Codex CLI and Cursor Agent were not installed in the CI image; the artifact validator explicitly reports those host checks as unavailable. Local artifact schema validation still ran.

The `migration:validation` job stores `migration-validation.log` as a CI artifact for seven days. Job logs are the primary execution evidence; this document intentionally omits runner addresses, account details and CI upload tokens.

## Public CLI fixture actually exercised

The integration test launches the shipped `bin/gbot.mjs`, which runs the freshly built CLI, against a loopback HTTP fixture with synthetic credentials and data. It tests all five command help pages, inventory, read-only source export, offline inspection, plan, apply, verify, overwrite refusal, destination tampering and failed transcript reads.

The fixture asserts that source requests use only `listAgents`, `getAgentTranscriptTail` and `getAgentWorkflows`; no send or mutation method is permitted. It removes gateway credentials before the offline conversion and asserts that the server request count does not increase. It checks source workflow body preservation, source token exclusion, partial export exit 3, and retention of independently successful workflow reads.

This is a real built-CLI and filesystem integration test with a synthetic remote service. It is **not** a live Grok Bot account test or an activated OpenClaw agent test.

## Problems found and fixed during verification

1. The first integration test invoked the generated artifact directly with a leading `--json`, bypassing the public launcher that normalizes this option. Pipeline 3040977749 failed rather than being treated as success. The test now uses the actual public entrypoint.
2. Self-review found a change-between-reads gap: archive bytes were checksum-checked, then read again for parsing. The exact parsed bytes are now compared with the recorded size and digest as well. This does not claim protection against a malicious same-user process rewriting the entire archive and manifest.
3. A local adversarial case reproduced `apply --out ARCHIVE/staged --yes` modifying the source archive before verification rejected the unexpected directory. Canonical destination containment is now checked before writing. Three regression cases cover nested output, identical source/destination, and a symlinked ancestor hiding nested output; all assert byte-for-byte preservation.
4. The newly enabled full typecheck exposed JavaScript options inference omitting `out` for migration apply and omitting supported injected options for the existing relay engine. The apply parameter now has an explicit string default and its existing missing-output guard remains intact. The relay change is JSDoc only; runtime behavior is unchanged.
5. Full route tests exposed an existing Linux fixture mismatch: the invalid gateway descriptor was written with default XDG paths, then the CLI was run with `XDG_CONFIG_HOME=home`. The fixture now writes and reads with the same environment, explicitly asserts path equality and preserves all previous behavior assertions. Both relay tests passed on the final code run.

No assertion was removed to obtain a green run. No existing failure was relabeled as a pass.

## Safety and data-loss regressions covered

Exact schema/version rejection; UTF-8 preservation and invalid UTF-8 rejection; field allowlisting; duplicate identities and workflow IDs; per-bot workflow reads; absent bodies; malformed responses; bounded transcript tails; independent failures; deterministic conversion; exact source-to-destination byte comparison; tampering with data or checksums; hostile paths; extra active files; symlinks and hardlinks; oversized files; nonregular files; incomplete output without a manifest; existing-directory refusal; repeat apply; source/destination containment; and explicit opt-in for staging skill instructions.

## Gates still not satisfied

- Live authenticated Grok source export, followed by registration and behavior testing in a running OpenClaw runtime: **not executed**. No corresponding source login/runtime was available to this execution environment. Do not describe fixtures as this test.
- Full history, learned memory, attachments, cloud files, OAuth grants and runtime/cron restoration: **not implemented or claimed**. `complete` remains false; `verify` reports file integrity, not runtime correctness.
- Native OpenClaw migration-provider registration: **not implemented**. The target is standalone workspace staging.
- Windows execution: GitLab-hosted job 17837280011 did not start because GitLab reported `ci_quota_exceeded`. The existing self-hosted Windows job 17837280010 was manually triggered; at the recorded 09:14 check it was still pending with no runner assigned. Neither is a Windows pass. No billing or runner-protection settings were changed.
- macOS execution and OS login/keychain integration: **not executed in this change**.
- Dependency security: `npm ci` on the unchanged dependency lockfile reported 10 findings (2 moderate, 7 high, 1 critical). No dependencies were added, but these findings were not triaged or fixed here. A successful functional check is not dependency security clearance.

## Release decision

The researched plan, working limited migration workflow and reproducible automated tests are ready for review. Keep the MR draft while live-provider/runtime acceptance, platform coverage and dependency findings are unresolved. Do not publish this as a lossless one-click account migration. No source bots, credentials, destination runtime, existing user directories or npm release were changed by this implementation session.

Related: [implementation plan](../migration-toolkit-plan.md) · [usage and limitations](../migration-toolkit.md).
