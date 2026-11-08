# Grok Bot migration toolkit

This branch implements a **limited snapshot and offline OpenClaw workspace staging**, not a lossless account transfer. Nothing deletes or changes the source bots. No destination agent or scheduled task is activated.

## Build this branch

The released tarball does not contain this feature yet. Use Node 22.19+ (22.x) or 24.2+ and a separate checkout:

```sh
git clone --branch feature/migration-toolkit https://gitlab.com/aa22396584/grok-bot-cli.git grok-bot-migration
cd grok-bot-migration
npm ci
npm run build
node bin/gbot.mjs migrate --help
```

The commands below use the public launcher `node bin/gbot.mjs`. It handles leading `--json` and runs the freshly built `dist` CLI. The already tracked artifact alone is not a substitute for rebuilding the branch. No npm publication is required.

## Capture, review, stage, verify

Sign in to your own Grok Bot desktop app first. Use `gbot accounts` to identify the intended login. Replace `personal` with that login's alias, label or unique ID prefix. The parent of each output directory must exist; each output directory itself must be new.

```sh
node bin/gbot.mjs migrate inspect --account personal
node bin/gbot.mjs --json migrate export --account personal --out ../grok-backup
node bin/gbot.mjs migrate inspect ../grok-backup
node bin/gbot.mjs migrate plan ../grok-backup --to openclaw
node bin/gbot.mjs migrate apply ../grok-backup --to openclaw --out ../openclaw-staged --yes
node bin/gbot.mjs migrate verify ../grok-backup --out ../openclaw-staged
```

`inspect` without an archive reads inventory only. `export` reads at most 200 trailing entries per bot/group (`--limit 1..200`). `plan`, `apply`, `verify`, and `inspect ARCHIVE` are offline and need no login. `apply` writes new workspace files only; it does not run OpenClaw, register an agent or alter `~/.openclaw`.

By default, workflow text stays in each `source.json` as archived data. To stage user-owned workflow bodies as loadable `SKILL.md` instructions, review a plan with the same explicit option used by apply:

```sh
node bin/gbot.mjs migrate plan ../grok-backup --include-skills
node bin/gbot.mjs migrate apply ../grok-backup --include-skills --out ../openclaw-with-skills --yes
```

Plugin/managed workflows and automations never become active skills. Source names never determine file paths; hashed source IDs avoid name collisions and path traversal. Templates and instructions are untrusted source content: read them before attaching a workspace to an agent.

## What is preserved

- Returned bot/group identities, explicit instructions and group member IDs
- Normalized user/assistant/unknown messages from the observed tail, with source IDs and available timestamps
- Observed workflow bodies and the returned `trigger.schedule` text, separately for each bot
- SHA-256 file inventory, capture timestamp, errors and explicit coverage limitations

The archive contains `manifest.json`, `snapshot.json` and `REPORT.md`. A staged bot has `AGENTS.md`, `IDENTITY.md`, `source.json`, `archive/messages.json`, and optionally `skills/<hashed-id>/SKILL.md`. Groups remain archives, not invented OpenClaw group routing. Every verification compares staged bytes with a deterministic conversion of the source, not only with destination-provided checksums.

## What is not preserved or verified

`complete` is always `false`. The roster helper does not expose server truncation; it therefore cannot establish account-wide completeness. A successful 200-entry read is not full history. `--after` on the old thread command is a local tail filter, not backward pagination. Cursor's separate `ReadTranscript` Bot tool is not invoked automatically here.

No hidden/learned memory, attachment bytes, cloud files, connector credentials, login sessions, runtime permissions, skill supporting files, timezone/cron semantics or live task state is reconstructed. No claim is made that every returned workflow body is a complete original skill package. Old messages are archived evidence, never replayed as current commands or synthesized into `MEMORY.md`.

A passing `verify` establishes archive or staged-file integrity only. It reports `runtimeVerified: false`. OpenClaw may apply its own bootstrap text limits; byte equality does not prove all instructions entered the model context. Register and activate reviewed workspaces using the installed OpenClaw version's documented setup.

## Failures and privacy

Exit 0 means the requested operation completed within the reported limited scope. Exit 3 means source reads failed: the partial archive remains usable for inspection, but apply refuses it. Usage, invalid schemas, checksum failures, unsafe files or existing destinations are nonzero errors. Source field absence (for example a missing body) stays explicitly absent; it is not fabricated.

Existing files and directories are never overwritten, even empty ones. The manifest is written last; interrupted output is incomplete and will fail verification. Preserve it for inspection and export to a fresh directory. The tool never recursively deletes failed output.

Credential-shaped extra fields are excluded by an exact schema. However, the messages, instructions and skill text themselves are **private plaintext** and may contain secrets you wrote there. Keep the archive outside a public repository and share it only intentionally. The tool does not promise universal content redaction or encryption. SHA-256 detects accidental changes; without a separately trusted digest it is not proof of origin against an attacker who rewrites both data and manifest.

On POSIX, newly created directories are 0700 and files 0600. On Windows, inherited ACLs still require the operator's private directory policy; POSIX mode bits are not an ACL guarantee. Final symlinks, nonregular files, hardlinked files, path traversal and untracked files are refused. The tool is not a sandbox against another process with the same user privileges racing parent-directory changes.

Source reads reuse existing authentication and URL restrictions. Establishing a session or reading a sleeping box may use gbot's existing wake behavior. No prompt is sent and no source data mutation RPC is issued by migration. Workflow reads do not silently retry or switch accounts. An explicit `--account` together with gateway URL/token overrides is refused.

For local profile-only recovery, use `migrate export --files --dir /path/to/agents --out NEWDIR`. This does not recover conversations or skills; do not combine it with `--account`.

## Tests and research

Implementation plan: [migration-toolkit-plan.md](migration-toolkit-plan.md).

```sh
node --test test/migration.test.js
npm run check
```

The test suite covers actual filesystem operations, source protocol mocks and a loopback server reached through the public CLI and generated worker. These are deterministic tests, not live Grok account or running OpenClaw validation. The `migration:validation` CI job saves its full log as an artifact.

Primary references checked on 2026-11-08:

- https://forum.cursor.com/t/grok-bot-forever-box-agent-transcripts-mirror-never-created-server-agent-proxy-transcript-tail-connecterror/172494/13
- https://cursor.com/docs/grok-bot/work
- https://docs.openclaw.ai/cli/migrate
- https://docs.openclaw.ai/concepts/agent-workspace
- https://docs.openclaw.ai/tools/skills
