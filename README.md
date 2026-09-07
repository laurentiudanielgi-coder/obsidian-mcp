# obsidian-mcp

An MCP (Model Context Protocol) server for Obsidian vaults, speaking to the
vault as plain markdown files on disk. **Built as a learning project**: the
priority is understanding how MCP works internally, so the code deliberately
uses the SDK's low-level `Server` class and comments explain the protocol at
every step.

## What it does (v0.1 — milestone 1)

- Speaks JSON-RPC over stdio (the transport Claude Desktop uses to spawn it)
- Completes the `initialize` handshake and declares `tools` capability
- Exposes one tool: `vault_info` (vault path + note count) to prove the loop

Full roadmap in [PLAN.md](PLAN.md).

## Run

```sh
npm install
npm run build
OBSIDIAN_VAULT_PATH=/path/to/your/vault npm start
```

The process reads JSON-RPC on stdin and writes responses to stdout — that's
the whole interface. For a human-friendly tour, install the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector node dist/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"],
      "env": { "OBSIDIAN_VAULT_PATH": "/Users/you/Obsidian/MyVault" }
    }
  }
}
```

## Development

```sh
npm test        # speaks raw JSON-RPC to the built server over a real pipe
npm run dev     # tsc --watch
```

The integration tests in `test/server.test.ts` fork the built server and
exchange newline-delimited JSON-RPC frames with it — the same bytes a real
client sends. Reading that test is the fastest way to see the protocol.

## Key ideas the code teaches

| Concept | Where to look |
| --- | --- |
| Server config via env vars (clients spawn servers) | `src/config.ts` |
| The `initialize` handshake + capabilities | `src/server.ts`, top comment |
| Tool discovery: `tools/list` descriptions are for the model | `src/server.ts` |
| Tool errors vs protocol errors (two failure channels) | `src/server.ts`, `tools/call` handler |
| Transports: stdio framing, stdout-is-protocol rule | `src/index.ts` |
| Raw wire format | `test/server.test.ts` |

## References

- [MCP specification](https://modelcontextprotocol.io/specification)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Official filesystem reference server](https://github.com/modelcontextprotocol/servers) — ~80% of what this project will become, worth reading side by side
