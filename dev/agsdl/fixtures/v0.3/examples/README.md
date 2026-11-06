# Examples

Complete AgSDL 0.3.0 documents. Each one is valid. Validate them all from
`tooling/`:

```sh
python3 -m agsdl ../examples/*.json
```

## Which one to read

| You want to | Read |
| --- | --- |
| Send work back and forth until a reviewer is satisfied | [write-and-review](write-and-review.json) |
| Get several independent opinions and decide by vote | [parallel-review](parallel-review.json) |
| Let the tests, not the agent, decide when the work is done | [fix-until-green](fix-until-green.json) |
| Tell a working agent about something that happens outside, such as CI | [ci-watcher](ci-watcher.json) |
| Have a person approve before anything is published | [release-approval](release-approval.json) |
| Reuse the same review process in several flows | [reusable-review](reusable-review.json) |
| Plan with one agent and build with another, the plan as its mission | [plan-and-build](plan-and-build.json) |
| Spread work over many files with a bounded number of workers | [fix-each-file](fix-each-file.json) |
| Review each changed file of a pull request, and stop at the first blocker | [review-changed-files](review-changed-files.json) |
| Configure one agent precisely, without any flow | [assistant](assistant.json) |

## What each one shows

| Example | Shows | Harnesses |
| --- | --- | --- |
| [write-and-review](write-and-review.json) | A loop by choice; a fresh reviewer each time; a completion check. | Codex, Claude Code |
| [parallel-review](parallel-review.json) | Three parallel reviews, a quorum vote, a result schema, branch results sent back. | Claude Code, opencode |
| [fix-until-green](fix-until-green.json) | A command call routed on its outcome, the test output sent to the same developer. | pi |
| [ci-watcher](ci-watcher.json) | A watcher that steers a working developer; a join; an MCP permission. | Claude Code, Codex |
| [release-approval](release-approval.json) | A selected result in a message, an approval, an MCP call that publishes what was approved. | Codex |
| [reusable-review](reusable-review.json) | A composition with a join, bound to an agent. | Claude Code, opencode |
| [plan-and-build](plan-and-build.json) | An agent that instructs another; a default prompt for routes that bring none. | Claude Code, Codex |
| [fix-each-file](fix-each-file.json) | A fan-out over a result list, four workers at a time; failed files kept and sent back; time limits; a person's answer bounded; the flow's error route. | Codex, Claude Code |
| [review-changed-files](review-changed-files.json) | A command's output read as lines; one reviewer per changed file, eight at a time; a quorum of one that starts no further review and waits for the started ones. | opencode, Claude Code |
| [assistant](assistant.json) | One fully configured agent without a flow: skills, MCP, permission rules, plan, plan first, completion check. | Claude Code |

Draw any flow with:

```sh
python3 -m agsdl.mermaid ../examples/ci-watcher.json
```

Model names such as `example/large`, skill paths and the MCP server URLs are
fictional.
