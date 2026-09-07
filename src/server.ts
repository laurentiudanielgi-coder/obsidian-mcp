/**
 * server.ts — the MCP protocol layer.
 *
 * LEARNING NOTE — why the *low-level* `Server` class:
 * The SDK ships two layers:
 *   - `McpServer` (high-level): register tools with one call, schemas handled
 *     for you. Convenient, but the protocol becomes invisible.
 *   - `Server` (low-level): YOU register a handler per JSON-RPC method, keyed
 *     by the exact method name from the spec ("tools/list", "tools/call").
 * We use the low-level one on purpose: this project exists to learn how MCP
 * actually works, and here every protocol concept is visible in code.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * LEARNING NOTE — the MCP lifecycle (what happens before any tool runs):
 *
 *   client                                server (us)
 *     │  1. initialize request              │
 *     │ ───────────────────────────────────▶│  we reply with: our name/version,
 *     │  2. ◀───────────────────────────────│  the protocolVersion we share
 *     │                                     │  with the client, and our
 *     │                                     │  *capabilities* (what we can do).
 *     │  3. notification: initialized       │
 *     │ ───────────────────────────────────▶│  (no reply — notifications
 *     │                                     │   never get responses)
 *     │  4. tools/list, tools/call, ...     │
 *     │ ◀──────────────────────────────────▶│  normal request/response work
 *
 * `capabilities` is the server telling the client, up front, which optional
 * protocol features it implements (tools? resources? prompts? logging?). The
 * client uses this to decide what UI to offer and which requests are legal to
 * send. We only declare `tools` for now; resources come in a later milestone.
 */
export function createServer(config: Config): Server {
  const server = new Server(
    // Identification, surfaced to the client during `initialize` and shown in
    // its UI/debug output. Purely informational.
    { name: "obsidian-mcp", version: "0.1.0" },
    // Capabilities: we implement the `tools` feature, nothing else (yet).
    { capabilities: { tools: {} } },
  );

  /**
   * LEARNING NOTE — "tools/list" is metadata, not execution:
   * The client asks once "which tools do you have?" and caches the answer.
   * Each tool needs:
   *   name        — stable identifier the model will call
   *   description — WRITTEN FOR THE MODEL, not for humans. This is the only
   *                 thing the LLM sees when deciding which tool to use and
   *                 with which arguments. Vague descriptions cause wrong calls.
   *   inputSchema — JSON Schema for the arguments. The client validates (and
   *                 the model generates) arguments against it.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "vault_info",
          description:
            "Report the vault root path and how many markdown notes it contains. " +
            "Use this first to confirm the vault is mounted and readable.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            // `[]` = no arguments accepted. JSON Schema keyword, not a typo.
            required: [],
          },
        },
      ],
    };
  });

  /**
   * LEARNING NOTE — "tools/call" is where the model's request lands:
   * Two DIFFERENT failure channels, a distinction the spec is strict about:
   *   1. Protocol error  → throw / reject. The SDK turns it into a JSON-RPC
   *      error response (id matches request, no `result` field). Reserved for
   *      "you spoke the protocol wrong" — unknown tool, malformed envelope.
   *   2. Tool result with `isError: true` → a NORMAL response whose payload
   *      says the operation failed. This is how "file not found" is reported:
   *      the request was valid; the *work* failed. The model reads this text
   *      and can react (retry, apologize, try another path).
   * Getting these backwards is the classic MCP bug: throwing on a missing
   * file surfaces as a protocol crash to the client instead of feedback
   * to the model.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === "vault_info") {
      const noteCount = await countMarkdownNotes(config.vaultPath);
      return {
        content: [
          {
            type: "text",
            text: `Vault root: ${config.vaultPath}\nMarkdown notes: ${noteCount}`,
          },
        ],
      };
    }

    // Unknown tool name = the client/model asked for something we never
    // advertised. That is a protocol-level mistake → protocol error.
    // The SDK's `McpError` becomes JSON-RPC error code -32602 (invalid params).
    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

/** Recursively count *.md files under the vault. Tiny on purpose — the real fs layer arrives in milestone 2. */
async function countMarkdownNotes(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // `.obsidian` is Obsidian's own config dir (workspace state, plugins) — not notes.
    if (entry.name === ".obsidian" || entry.name === ".trash") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += await countMarkdownNotes(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) count++;
  }
  return count;
}
