# Synthetic Pilot flows

With the repository's Bun dependencies already installed, run:

```sh
bun dev/pilot-synthetic-flows.mjs
```

The command runs `syntheticFlows.test.ts` through `dev/run-tests.mjs`, which
isolates test files in separate Bun processes. It accepts no arguments, relay
URL, credential, or configuration file. No native build or external service is
needed. The suite also participates in the normal test discovery.

## Boundary under test

The tests instantiate the public `MacroPilotNativeClient` and `PilotRuntime`.
They exercise the real account client, kernel, desktop stores, content host,
task catalog, conversation capture, protocol validators, and persistence
contracts. Only the external boundaries are substituted:

- A memory vault and metadata map retain synthetic values between client/runtime
  instances. Vault callbacks inject refusal, suspension, and recovery results.
- An injected fetch adapter accepts only `https://pilot.synthetic.invalid`.
  It supplies authentication/account fixtures and queues producer deliveries.
  Task cards and conversation responses are produced by Macro, not the adapter.
- A closed IPC adapter supplies synthetic conversation records, the export
  policy, and compare-and-swap storage. Git captures report `content_unavailable`.
  Any other IPC, including credentials and native HTTP, fails and is counted.
- Global fetch is blocked and asserted unused. The fixture module requires
  `NODE_ENV=test` and is never imported by production code.

The identity uses a fictitious GitHub subject and login. The device verification
URL is protocol data only; no browser or OAuth flow is opened. All tokens are
synthetic. Nothing is saved to the OS credential store or a personal account.

The gateway is local to the test process, not a loopback socket. Injection is
already supported by the public client and retains its HTTPS, origin, response,
credential, and lifecycle checks. A socket would require TLS test certificates
or a weaker origin policy without adding coverage of these lifecycle races.
This suite does **not** validate DNS, TLS, socket behavior, native HTTP, OAuth,
server-side ACL enforcement, or the Rust credential manager. The gateway is a
small scripted peer, not an implementation or conformance test of the relay.

## Covered flows

The happy path starts with empty metadata and an empty vault. It connects,
polls the fictitious identity, rejects confirmation of a different account,
confirms the account, creates the instance, and reads the account catalog.
The real runtime then serves task cards, the conversation catalog, and message
content. Fresh client/runtime objects restore the session against the same
memory storage. Logout persists cleanup references despite failed physical
secret deletion, and another restart cannot restore the session or poll.

Parameterized refusal and suspension flows interrupt a delivery at its final
authorization boundary. Local preparation may already have read messages;
no result is exported and no further message read occurs after the block.
Repeated initialization, catalog refresh, and runtime retry preserve the block
without invoking vault recovery. Explicit recovery restores content delivery
without replaying account confirmation or instance creation.

A separate race holds an explicit recovery open across logout. Its late result
is rejected, and a fresh runtime cannot restart the producer. Destination tests
also reject an external origin and exercise the production HTTP rejection.

## Limits

Restart means fresh JavaScript client/runtime objects over retained in-memory
storage, not a process or operating-system restart. The fake vault tests the
frontend reaction to native statuses; it does not reproduce Keychain internals.
These flows supplement the existing client, runtime, and native lifecycle tests.
Real iPhone/device flows remain manual acceptance recipe 10.
