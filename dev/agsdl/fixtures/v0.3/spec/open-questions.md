# Open questions

These questions are not settled in AgSDL 0.3.0. Nothing in this page is a
requirement. Each question can be settled later by an optional addition,
without changing the meaning of a 0.3 document.

## Declared call outcomes

A call's outcome is `passed` or `failed`. Some commands give several exit
statuses distinct meanings, such as a test runner that reports flaky tests
with its own status. A call could declare its outcomes, for example one name
per exit status, with `passed` and `failed` as defaults. No use case requires
it yet.

## Forking an instance

A step could start a new instance that copies an existing instance's
conversation. Several harnesses can fork sessions. No use case requires it yet.

## Best-effort properties

A document could mark some properties as optional, so that one agent moves
between harnesses without errors. If added, the list would be limited to
quality settings, such as effort, and would never include permissions or
limits.

## Further agent properties

Harnesses also expose turn and token limits, context compaction, tool
allow-lists, replacement of the base system prompt and hooks. They are left to
`harnessSettings` until a survey of harnesses shows which of them can be
standardized with a shared meaning.

## Protected actions

AgSDL 0.2 let an approval protect a named action and checked that no route
bypassed it. AgSDL 0.3.0 keeps approvals as simple decisions. Whether to bring
back protected actions, now that permissions have an `ask` effect, is open.
