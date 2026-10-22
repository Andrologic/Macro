# Connect reader authority

The optional [read-authority-1 contract](content-contract-v2.md#bounded-read-authority-read-authority-1)
allows already received content to remain visible during a network failure.
The proof lasts at most 30 seconds, measured from the exact negotiation start
before the credential wait. Each capture also keeps its own fixed deadline.
Renewal can replace the proof without resetting the event cursor or rereading
healthy transcripts. It cannot extend a retained capture.

## Native availability

The native composition does not offer this capability. Its suspension barrier
has not been demonstrated before the first WebView render after resume.
Detecting macOS or receiving a vault event does not establish that ordering.
The existing online reader remains available. Native acceptance is still open;
the synthetic checks below do not close it.

A composition may opt in only through the injected, independently verified
lifecycle support. There is no persisted switch, new endpoint, credential store,
transport, global transcript registry, or change to the producer host.

## Presentation and renewal

Each target has one proof, one renewal attempt and one renewal timer, shared by
its visible readers. Panels start reading when they enter the visible viewport.
Leaving the last visible reader cancels its UI requests, renewal and unfinished
initial preparation. An already established feed keeps receiving invalidations.
A preparation shared with another visible reader continues. Acquiring a new visible
lease and showing an existing one use the same admission transition; both resume
rights and continuity after zero visible demand without reopening known refusals.
A late cancelled negotiation cannot start bootstrap or monitoring; returning requires a fresh
context. Hiding the document or leaving
the page purges the reader context; returning requires fresh rights and feed
continuity.

During a retryable outage, still-valid RAM pages are passive. Scrolling and
closing remain available; copying, selection, dragging, navigation and new reads
are disabled. Protected text, conversation titles and accessible names leave the
rendered projection at proof expiration. Private captures remain bounded until
their own expiration, eviction or closure. An expired or purged capture cannot
return through proof renewal.

Known refusal, audience replacement, credential generation change and
suspension retire publication before aborting requests. A simple proof expiration
does not cancel a current renewal. Recovery reuses the finite shared retry
policy and any ordinary renewal already in flight, including one that settles
during backoff. A new proof received during recovery does not extend the target's
confirmed presentation deadline until its own event continuity has been applied
and acknowledged. Other targets' notifications cannot unlock its expired
projection. Healthy ordinary renewal updates that deadline without resetting the
feed or rereading content. Rights and event continuity are checked before actions
resume. After exhaustion, a relay that becomes healthy without a network or
visibility transition requires manual retry. There is no additional periodic
retry loop.

The old-relay fallback requires a closed v1 HTTP 400 negotiation error with
matching body and header request IDs. Only read-authority-1 is removed first.
HTTP 401/403, malformed errors, missing headers and contradictory proofs cannot
trigger that fallback.

## Local synthetic recipe

Run `bun run dev --host 127.0.0.1` and open
`http://127.0.0.1:1422/dev/connect-consumer-qa.html`, using the actual Vite port
reported by the command. This DEV-only, loopback-only fixture uses synthetic
ports and data. It imports no native producer composition and contacts no
account, vault, provider, relay or OAuth service.

Open Alpha and Beta, then one conversation in each. Toggle synthetic offline.
The existing text stays passive until its remaining proof expires. Verify that
copy/cut/drag and copy shortcuts are blocked, directory names are hidden, and
text/titles disappear at expiration. Toggle online, then press **Alt+Shift+C**
while the reader modal is open once both pending feeds are waiting. The global
shortcut also invokes the DEV **Release continuity · Alt+Shift+C** button's action.
This emits an empty page on each pending Alpha/Beta feed without resetting its stream. The finite retry and
cursor continuation can then finish. A stream reset invalidates only its target.
Changing the synthetic account retires the whole reader. Exercise the layout at
900×700, 1280×720 and 1440×900, including scrolling, focus and panel closure.

Run the focused tests with:

```sh
bun run test -- readAuthority.test targetClient.test consumerDirectory.test consumerConnections.test consumerReader.test ConnectConsumerDialog.test macroConnectReader.test runtimeContent.test syntheticFlows.test
```

The deadline tests inject monotonic time and renewal timers. The transport tests
exercise the native TypeScript credential port with synthetic dependencies; DOM
tests exercise the real reader and owner. Request counts prove shared renewal
and zero healthy transcript rereads. They do not measure process heap, battery,
WebView resume ordering, real network behavior or server ACL enforcement.
