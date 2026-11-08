# Migration toolkit implementation plan

Date: 2026-11-08 (Asia/Taipei)
Base: `80874cac80a4d641b96a1dba420f3e0f1fc4b01c`
Branch: `feature/migration-toolkit`

## Goal and release boundary

Make user-owned Grok Bot data portable without deleting the source, executing imported instructions, copying authentication, or pretending a transcript tail is a full archive. Deliver working `gbot migrate inspect`, `export`, `plan`, `apply`, and `verify` commands, a versioned offline archive, and an OpenClaw workspace staging target. A generated workspace is not an activated OpenClaw agent and is not a restoration of the provider's hidden memory or runtime.

## Research checked on 2026-11-08

- Cursor staff response, dated 2026-10-12: no public full-history export API; the Bot's `ReadTranscript` tool pages backward in batches of up to 200. This is not the CLI gateway's limit-only `getAgentTranscriptTail` endpoint. https://forum.cursor.com/t/grok-bot-forever-box-agent-transcripts-mirror-never-created-server-agent-proxy-transcript-tail-connecterror/172494/13
- Cursor documents Bot templates and duplication separately from history, learned memory, attachments, files and sign-ins. https://cursor.com/docs/grok-bot/work
- OpenClaw documents plugin-owned migration providers; bundled providers are Claude, Codex CLI and Hermes. No built-in Grok provider was established by this research. Native migration needs exclusive local state ownership. This first implementation stages standalone workspaces and does not impersonate a registered provider. https://docs.openclaw.ai/cli/migrate
- OpenClaw workspace instructions live in `AGENTS.md`; workspace skills use `skills/<name>/SKILL.md` with YAML frontmatter. Bootstrap prompt length limits are separate from file integrity. https://docs.openclaw.ai/concepts/agent-workspace and https://docs.openclaw.ai/tools/skills

## Source-code findings

`src/core/gateway.js` uses the 0.78.x server roster and authenticated gateway reads. `listSkills()` deliberately returns metadata only; its test says it strips bodies. `thread` is capped at 200 entries and `--after` filters the bounded tail locally. Neither `--after` nor a successful read proves full-history coverage. `listAgents()` does not expose roster truncation metadata publicly. Existing `history.jsonl` is opt-in and is not a complete server archive.

## Implementation stages

1. **Portable core:** strict versioned schema; allowlisted fields; SHA-256 integrity; bounded file reads; deterministic conversion; explicit completeness, errors and unsupported features. Archive and destination directories are private, create-only and never overwrite existing data.
2. **Source adapter:** reuse current login, roster and transcript helpers; read workflow bodies through the existing authenticated gateway request policy; enumerate workflows per bot so per-bot automations are not silently conflated with the account library. Preserve skill availability and unsupported shapes explicitly. Never send a model prompt or issue a mutation RPC as an implicit export step. Existing connection/wake behavior is disclosed.
3. **CLI:** inspect and export from the selected live login; offline plan/apply/verify require no login and no network. Export reports read failures as partial and returns nonzero while retaining independently useful captured data. Source IDs, not names, determine stable file paths.
4. **OpenClaw staging:** one workspace per bot; instructions and identity; archived conversations as evidence, not native sessions or inferred memory; validated user workflow skills only, with explicit consent to stage executable instructions. Plugin/managed/automation items remain review-only. No automatic model configuration, OAuth, group routing, cron activation or Gateway start.
5. **Verification:** local dependency-free unit tests; source-wire mocks; generated-CLI round trip; tamper, traversal, symlink, collision, interrupted-write and missing-body regressions; existing unit tests, build, typecheck and route tests in GitLab CI where dependencies are available. Record commands, actual outcomes and limitations rather than extrapolating from an older green pipeline.

## Acceptance criteria

- The five commands exist in the built CLI and have usable help.
- Export, plan, apply and verify work with deterministic synthetic fixtures, without accessing a real account.
- Exact byte hashes match before and after staging; tampering and unsupported schemas fail closed.
- Missing history/body/attachment/memory data is visible in both machine output and the human migration report.
- Partial reads cannot be reported as a complete successful migration.
- Existing directories/files and source data are preserved; interrupted publication is visibly incomplete.
- Secrets in credential-shaped fields are never serialized; free-text content may contain user secrets and is treated as private. No claim of universal content redaction.
- Tests and evidence are committed; MR stays draft until the recorded gates are met or explicitly documented as blocked.

## Deferred, not silently claimed

A live authenticated source-to-running-OpenClaw end-to-end test requires a Grok Bot login on a machine the runner can access plus an installed OpenClaw runtime. This execution environment must not invent credentials or call a mocked run a live test. Full transcript pagination, auxiliary cloud files, durable learned memory and native OpenClaw provider registration need separately verified interfaces. Assisted `ReadTranscript` exports can be developed later with explicit send approval; they are not an undocumented endpoint guessed here.
