# Contributing to grok-bot-cli

中文：歡迎用中文開 issue 或 merge request。

Thanks for helping. Bug reports, fixes, and docs changes are all welcome.

## Development setup

Node.js 22.19.0+ and npm.

```bash
git clone https://gitlab.com/aa22396584/grok-bot-cli.git
cd grok-bot-cli
npm ci
npm run build
npm run typecheck
npm test
```

`npm test` runs `test:unit` and `test:routes`. Some suites are Unix-only and skip on Windows; [FORK.md](FORK.md#windows-limitations) lists them.

## Ground rules

- This is a fork. Fork-only changes are listed in [FORK.md](FORK.md). A fix that also applies upstream should go to [ScriptedAlchemy/grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) as well.
- Tests never reach a real Grok Bot login. Set a temporary `HOME` if you have the app signed in.
- Never commit tokens, cookies, credential files, account, chat, or bot ids, message text, emails, IP addresses, host names, or absolute local paths. Use fake values in tests and docs.
- Docs come in pairs: `README.md` / `README.zh-TW.md`, `FORK.md` / `FORK.zh-TW.md`, and `docs/migration.md`, `docs/move-to-hermes.md`, `docs/reference.md` with their `.zh-TW.md`. Change both files of a pair together. The upstream reference in `docs/reference.md`, the other upstream docs in `docs/` and the records in `docs/verification/` are English only.
- A bug fix comes with a test that fails without it.
- One topic per merge request. Describe how you tested it.

## CI

GitLab CI runs the tests on Linux for every push and on Windows for merge requests (manual), tags, and `main`. A fork uses GitLab.com shared runners by default. Set the `LINUX_RUNNER_TAG` and `WINDOWS_RUNNER_TAG` CI/CD variables to use other runners. There is no macOS CI; maintainers test macOS locally.

## Release process (maintainers)

1. Update `CHANGELOG.md` and the fork notes in `FORK.md` and `FORK.zh-TW.md`.
2. Merge to `main` and wait for a green pipeline.
3. Build the package with `npm ci && npm run build && npm pack`.
4. Tag `vX.Y.Z-iml1s.N` on `main`, push the tag, and attach the `.tgz` to the GitLab Release for that tag. There is no release job; the upload is manual.
5. Update the `.tgz` link in `README.md`, `README.zh-TW.md`, `FORK.md`, `FORK.zh-TW.md`, and trinity-cli's README.
6. Do not publish to npm. The `grok-bot-cli` name on npm belongs to upstream.

Never move or delete a published tag. Fix forward with a new version.
