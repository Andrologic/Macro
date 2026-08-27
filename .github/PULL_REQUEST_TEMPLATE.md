## Summary

Describe the change and the user-visible or developer-visible impact.

## Release notes

Write the short user-facing note this PR should contribute to the next release.
Use `Not user-facing` only when that is genuinely the case.

## Checks

- [ ] `bun run version:check`
- [ ] `bun run repo:check-binaries`
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run i18n:audit`
- [ ] `bun run test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

If a check was not run, explain why.

## Risk Notes

Call out any impact on security boundaries, tool approvals, Git/worktree behavior, persistence, provider secrets, release packaging, or licensing.

## Screenshots

Add screenshots or recordings for meaningful UI changes.
