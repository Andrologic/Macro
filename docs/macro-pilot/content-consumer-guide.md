# C/D/E integration guide for A2

Read [the v2 contract](content-contract-v2.md) before implementing this extension.
The [registry](../../contracts/macro-pilot/v2/schema-set.json) is the portable
entry point. The desktop implementation is under `src/services/macroPilot/`:
`nativeClient.ts` owns transport, `accountClient.ts` owns account operations,
and `runtime.ts` coordinates `contentHost.ts` and the native capture commands.
This implementation does not certify a particular relay deployment or mobile
client. Negotiate capabilities with the actual peers before using them.

1. Load and test both registries independently. Run the v1 conformance and
   native transport checks, then `bun contracts/macro-pilot/test/validate-content.mjs`.
   Keep generated v1 validators and runtime routes unchanged until explicitly
   integrating consumers. A2's public helper is a conformance implementation,
   not a replacement for authorization or a browser runtime dependency.
2. C3 and D6 implement native account/session management and revocation races
   first. Use authenticated account ownership for management and desktop confirmation
   for deletion, preserved local identities and a fresh cloud incarnation on
   recreation. Test loss of the deletion/logout response, revoked replay, late GitHub
   identification/claim after invalidation and reauthorization at HTTP emission.
3. C4 exports the two instance catalogs from persisted conversations. Map
   scope_mode Chat to kind conversation with only a conversation ID; load
   content without changing UI selection. Test empty-but-unloaded caches,
   late insertions, deletion, pending text, malformed historical reasoning and
   multibyte excerpts. C5 implements and verifies immutable capture before
   pagination; test local edits between pages and immediately before verdict,
   nontext files, mode-only changes, unborn HEAD and expired snapshots.
4. D7 transports only validated envelopes, enforces the account/session scope
   at every boundary, bounds transient copies and combines invalidation streams.
   Test cross-account cursors and results, same-ID/different-body requests,
   gaps/restart, revoke while queued and revoke before cached result return.
5. E5/E6/E7 negotiate, retain outstanding requests for response correlation and
   show separate Implement/Conversation catalogs. Distinguish partial, pending,
   unavailable and stale content. Show all diff pages as available navigation;
   approve/request changes without read tracking. Clear caches on access loss.
6. Validate the participating implementations with end-to-end scenarios before
   enabling their integration. Advertise instance content only after desktop
   source and policy preparation succeeds. The current native implementation
   leaves content unavailable on Windows and WSL; ACCOUNT remains independent.
   A v1-only
   peer keeps v1 behavior and shows this extension unavailable. No downgrade
   converts new identities, local captures or account actions into v1 shapes.

The schema helper validates local relationships; stateful requirements are
listed at the end of the contract. Fixtures are synthetic and usable in Rust,
TypeScript and Dart. No private repository, account or service is needed to run
the public conformance tests. Backups and remote publication are outside scope.
