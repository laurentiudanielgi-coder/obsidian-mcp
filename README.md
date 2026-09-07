# obsidian-mcp

**Let Claude (or any MCP client) read, search, edit, and reorganize your Obsidian vault — safely.**

A [Model Context Protocol](https://modelcontextprotocol.io) server that treats your vault as what it really is: a folder of markdown files. No plugins, no cloud, no database. If Obsidian can be closed while Claude works on your notes, that's by design.

Written **to learn how MCP works internally**, and commented like it: the code deliberately uses the SDK's low-level `Server` class so the actual JSON-RPC protocol stays visible. If you want to understand what an MCP server *is* — beyond `npx some-server` — read this source next to the [spec](https://modelcontextprotocol.io/specification).

## What you can ask Claude

> *"How many notes are in my vault, and where are the newest ones?"*
> *"Find every note that mentions 'spaced repetition' and summarize the key ideas."*
> *"Create `research/glossary.md` with these ten terms and tag it `#glossary`."*
> *"Rename `daily/2026-09-06.md` to `journal/2026-09-06.md` — don't break any links."*
> *"Which notes link to my reading list? Show the exact lines."*

## The 11 tools

| Tool | What it does |
| --- | --- |
| `vault_info` | Vault path + note count — the "is it alive?" call |
| `list_notes` | Browse folders, with sizes and modification dates |
| `read_note` | Full markdown content of one note |
| `search_notes` | Full-text search (case-insensitive substring or regex), with `path:line` references |
| `get_frontmatter` | A note's YAML properties as JSON — cheaper than reading the whole note |
| `create_note` | New note, parent folders auto-created, optional YAML frontmatter generated |
| `edit_note` | Append, prepend (after frontmatter), find & replace, or replace a heading section |
| `delete_note` | To `.trash/` — **never** a permanent delete |
| `move_note` | Rename/move and **repair every link** across the vault |
| `get_backlinks` | What references this note? (wikilinks, embeds, relative markdown links) |

All read-only tools are annotated `readOnlyHint: true`, so MCP clients can skip approval prompts for them and only ask about writes.

## Safety model

Your vault is irreplaceable; the design starts there.

- **No path escapes.** Every user-supplied path goes through one guard (`safeResolve`); `../../../etc/passwd` comes back as a contained error, never a read
- **Deletes are reversible.** Notes move to the vault's `.trash/` (Obsidian's own convention) — never `rm`
- **No silent clobbers.** `create_note` fails if the note exists, unless you explicitly say `overwrite`
- **Kernel-atomic where possible.** Creates use the `wx` flag (no check-then-write race); deletes and moves are `rename()` calls
- **Link-safe moves.** Moving a note rewrites inbound links in other notes *and* rebases the moved note's own relative links — aliases and `#anchors` preserved
- **Empty-folder cleanup** after deletes/moves uses non-recursive `rmdir` up the tree: the kernel refuses anything non-empty, so cleanup is data-loss-proof by construction

The one rule that makes this work: the vault folder is the **only** thing this server can touch.

## Quick start

Requires Node 20+.

```sh
git clone https://github.com/laurentiudanielgi-coder/obsidian-mcp.git
cd obsidian-mcp
npm install && npm run build
```

### Claude Desktop

Edit `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"],
      "env": { "OBSIDIAN_VAULT_PATH": "/absolute/path/to/your/vault" }
    }
  }
}
```

Notes: use `which node` for the absolute path — GUI apps don't inherit your shell's PATH. Fully quit and reopen Claude Desktop. In Obsidian, set *Files & Links → Deleted files → .trash folder* so trash semantics match. And back your vault up (git works beautifully) — safety features are seatbelts, not brakes.

### Any other MCP client

The server is configured with one environment variable: `OBSIDIAN_VAULT_PATH`, pointing at the vault root. It speaks JSON-RPC over stdio — the default transport for locally-spawned MCP servers.

## How it's built

```
src/
├── index.ts   — entrypoint: transport wiring; why stdout is the protocol channel
├── server.ts  — protocol layer: handshake, capabilities, tools/list, tools/call
├── config.ts  — env-var config; why clients spawn servers and pass settings via env
└── vault.ts   — the only code that touches files: path guard, trash, links, edits
```

Architecture in one sentence: **JSON-RPC messages** arrive over a **transport** (stdio), get dispatched by the **protocol layer** to tool handlers, which delegate every filesystem operation to the **vault layer** — the single choke point where safety lives.

### For MCP learners

The codebase doubles as a guided tour:

| Concept | Where to look |
| --- | --- |
| The `initialize` handshake + capabilities | `src/server.ts`, top comment |
| Tool discovery: descriptions are written *for the model* | `src/server.ts` |
| Tool errors vs protocol errors (two failure channels) | `src/server.ts`, `tools/call` handler |
| The traversal guard when an LLM builds the paths | `src/vault.ts`, `safeResolve` |
| Obsidian link resolution & unique-basename rule | `src/vault.ts`, `linkMatches` |
| Stdio framing and the stdout-is-protocol rule | `src/index.ts` |
| Raw wire format | `test/server.test.ts` — speaks JSON-RPC to the real process |
| Debugging "hung" tool calls | [DEBUGGING.md](DEBUGGING.md) — the triplet rule, from a real incident |

### Development

```sh
npm test          # 52 tests: unit (real temp filesystems) + wire-level (raw JSON-RPC)
npm run dev       # tsc --watch
```

Two probe scripts exist for debugging clients against the server:

```sh
node scripts/big-create-test.mjs 9000        # create a 9,000-char note, time it
node scripts/create-from-json.mjs note.json  # replay an exact client payload
```

### Roadmap

- [x] CRUD, search, frontmatter, backlinks, link-repairing moves
- [ ] RAG: heading-aware chunking → local embeddings → sqlite-vec → `semantic_search`
- [ ] Streamable HTTP transport (same server, new transport — proving the decoupling)

Full decision log and reasoning in [PLAN.md](PLAN.md).

## License

[MIT](LICENSE)
