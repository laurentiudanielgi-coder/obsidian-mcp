#!/usr/bin/env node
/**
 * index.ts — entrypoint: wire config + protocol to a transport, and run.
 *
 * LEARNING NOTE — what a transport is:
 * The protocol layer (server.ts) deals in JSON-RPC messages. A transport is
 * the dumb pipe that carries those messages. The SDK decouples them, so the
 * SAME server code runs over:
 *   - stdio (this file): one JSON-RPC message per line on stdin/stdout.
 *     Used when the client spawns us as a child process (Claude Desktop etc.).
 *   - Streamable HTTP: messages over HTTP POST + SSE. Used for remote servers.
 * Swapping transports later is a 2-line change — a milestone of its own, to
 * prove the point.
 *
 * THE ONE RULE of stdio servers: stdout is the protocol channel. A single
 * stray console.log of debug text corrupts the JSON-RPC stream and the client
 * sees garbage. Everything we want to say to the human goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  // Config first: fail fast, before answering any protocol message, if the
  // vault path is missing — with a message a human reading stderr can act on.
  const config = await loadConfig();

  const server = createServer(config);
  const transport = new StdioServerTransport();

  // connect() starts the pumps: stdin lines → parsed JSON-RPC → our handlers
  // → responses written to stdout. From here on WE are a live MCP server.
  await server.connect(transport);

  // stderr only! (see THE ONE RULE above)
  console.error(`[obsidian-mcp] ready, vault=${config.vaultPath}`);
}

main().catch((err) => {
  console.error("[obsidian-mcp] fatal:", err);
  process.exit(1);
});
