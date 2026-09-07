# Debugging "hung" tool calls

Everything in this repo answers in milliseconds; when a client reports a
timeout, this is how to find where it actually stuck.

## The triplet rule

For every tool call, three lines should exist in the client's MCP log
(`~/Library/Logs/Claude/mcp-server-obsidian.log` on macOS):

```
<ts> Message from client: method="tools/call" id=N
[obsidian-mcp] tools/call <name>            ← our stderr proves arrival
<ts> Message from server: id=N result(1 blocks)   ← proof of answer
```

| Pattern | Meaning |
| --- | --- |
| all three, milliseconds apart | Work completed. If the chat still "timed out", the loss is above the MCP layer — the note may exist; check the vault. |
| client line only | Lost inside the client between send and our stdin |
| client + stderr, no response | Reached our handler and never answered — our bug, file an issue |

## Tools in `scripts/`

- `big-create-test.mjs <chars> [vault]` — raw-pipe create at arbitrary size;
  measures the server's ceiling in seconds (it is >100KB, ~300ms)
- `create-from-json.mjs note.json [vault]` — replays an EXACT client payload
  through the raw pipe for byte-for-byte comparison

## Case study (2026-09-07)

"4-minute timeouts" on create_note. Log triplets showed every call answered
in 2–3ms, all day — including every "failed" one. The waits were in the
client's session/relay layer, not the transport and not this server.
Hypotheses killed along the way (all disproven by the log): payload size,
non-ASCII frontmatter keys, Unicode filenames.
