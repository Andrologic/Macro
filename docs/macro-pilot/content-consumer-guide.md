# Macro Pilot 2.0 integration guide

Read [the v2 contract](content-contract-v2.md) before implementing this extension.
The [registry](../../contracts/macro-pilot/v2/schema-set.json) is the portable
entry point. The desktop implementation is under `src/services/macroPilot/`:
`nativeClient.ts` owns transport, `accountClient.ts` owns account operations,
and `runtime.ts` coordinates `contentHost.ts` and the native capture commands.
This implementation does not certify a particular relay deployment or mobile
client. Negotiate capabilities with the actual peers before using them. The
desktop account and content producers described below are implemented; the
remaining steps are a conformance checklist for each participating consumer,
not an implementation status report.

1. Load and test both registries independently. Run the v1 conformance and
   native transport checks, then `bun contracts/macro-pilot/test/validate-content.mjs`.
   Keep the v1 routes and validators separate from the negotiated v2 extension.
   The public helper checks conformance; it does not provide authorization.
2. The desktop account client implements native account/session management and
   revocation handling. The relay must apply the corresponding contract. Use
   authenticated account ownership for management and desktop confirmation
   for deletion, preserved local identities and a fresh cloud incarnation on
   recreation. Test loss of the deletion/logout response, revoked replay, late
   GitHub identification/claim after invalidation and reauthorization at HTTP
   emission.
3. The desktop exports the two instance catalogs from persisted conversations
   and captures immutable content before pagination. Map scope_mode Chat to
   kind conversation with only a conversation ID; load content without changing
   UI selection. Test empty-but-unloaded caches, late insertions, deletion,
   pending text, malformed historical reasoning, multibyte excerpts, local
   edits between pages and immediately before verdict, nontext files, mode-only
   changes, unborn HEAD and expired snapshots.
4. The relay must transport only validated envelopes, enforce the account/session
   scope at every boundary, bound transient copies and combine invalidation
   streams.
   Test cross-account cursors and results, same-ID/different-body requests,
   gaps/restart, revoke while queued and revoke before cached result return.
5. The mobile client must negotiate, retain outstanding requests for response
   correlation and show separate Implement/Conversation catalogs. Distinguish
   partial, pending, unavailable and stale content. Show all diff pages as available navigation;
   approve/request changes without read tracking. Clear caches on access loss.
6. Validate the participating implementations with end-to-end scenarios before
   enabling their integration. Advertise instance content only after desktop
   source and policy preparation succeeds. The current native implementation
   leaves content unavailable on Windows and WSL; ACCOUNT remains independent.
   A v1-only peer keeps v1 behavior and shows this extension unavailable. No
   downgrade converts new identities, local captures or account actions into
   v1 shapes.

The schema helper validates local relationships; stateful requirements are
listed at the end of the contract. Fixtures are synthetic and usable in Rust,
TypeScript and Dart. No private repository, account or service is needed to run
the public conformance tests. Backups and remote publication are outside scope.
