# obsidian-mcp — Plan

Personal Obsidian vault MCP server. **Priority: learning MCP internals.**
Everything else (features, polish) is secondary.

## Decisions made

| Decision | Choice | Why |
| --- | --- | --- |
| Language | TypeScript | Existing TS skill compounds; SDK's low-level layer + reference servers make protocol visible |
| Integration | Filesystem only | Vault = markdown files; no plugins, works when Obsidian is closed. REST plugin later if active-tab features are missed |
| SDK layer | Low-level `Server` class | See the JSON-RPC methods, not just decorators |
| Scope | Phase 1 = CRUD + search. RAG deferred to phase 2 | Foundation first; agentic full-text search covers much of "RAG" |
| Deployment | Native node process spawned by Claude Desktop | Docker rejected: no isolation gain (server needs vault write access), VirtioFS overhead on search, slower iteration |
| Vault | Single vault, <2k notes | No indexing strategy needed for v1 |
| Safety | Deletes go to trash, never permanent; all paths resolved inside vault root | The vault is irreplaceable; git recommended as real undo |

## Milestones

1. ✅ Scaffold + minimal MCP server + vault config + handshake test (v0.1)
2. ✅ fs layer with path safety (traversal guard) + trash deletes (v0.2)
3. ✅ Read tools: `read_note`, `list_notes`, `search_notes`, `get_frontmatter` (v0.3)
4. ✅ Write tools: `create_note` (wx-flag no-clobber, YAML generation), `edit_note` (append / prepend-after-frontmatter / find_replace / replace_section), `delete_note` (→ .trash)
5. ✅ Link tools: `get_backlinks` (wikilinks/embeds/relative-md, unique-basename rule), `move_note` with automatic link repair across the vault
6. Wire into Claude Desktop, end-to-end use on the Mac
7. (Phase 2) RAG: heading-aware chunking → embeddings (Ollama local vs API, decide then) → sqlite-vec or LanceDB → chokidar incremental index → `semantic_search`
8. (Stretch) Swap stdio transport for Streamable HTTP — proves transport/protocol decoupling

## Learning thread (keep answering as we go)

- What exactly travels on the wire at each step? (`test/server.test.ts`)
- Why does the spec separate protocol errors from tool results?
- What do capabilities buy the client? (Add `resources` in milestone 3 to see.)
- What changes when the transport changes? (Milestone 8)
