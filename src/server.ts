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
import { Vault, VaultPathError } from "./vault.js";

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
    { name: "obsidian-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  // The fs layer from milestone 2. Every tool below goes through it — no
  // handler touches a path directly.
  const vault = new Vault(config.vaultPath);

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
          inputSchema: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "list_notes",
          description:
            "List markdown notes in the vault (or a subfolder), newest info included. " +
            "Returns vault-relative paths — use those in read_note.",
          inputSchema: {
            type: "object" as const,
            properties: {
              folder: {
                type: "string",
                description: "Optional subfolder to list, vault-relative (e.g. 'projects'). Defaults to the whole vault.",
              },
            },
            required: [],
          },
        },
        {
          name: "read_note",
          description:
            "Read the full markdown content of one note. `path` is vault-relative " +
            "(from list_notes), e.g. 'projects/alpha.md'. The .md suffix is optional.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Vault-relative note path" },
            },
            required: ["path"],
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
   * The try/catch below is that policy in code: anything from the Vault layer
   * (bad path, missing file) becomes an isError result; only an unknown tool
   * name is a protocol-level throw.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "vault_info": {
          const notes = await vault.listNotes();
          return text(`Vault root: ${config.vaultPath}\nMarkdown notes: ${notes.length}`);
        }

        case "list_notes": {
          const folder = typeof args?.folder === "string" ? args.folder : ".";
          const notes = await vault.listNotes(folder);
          if (notes.length === 0) {
            return text(`No notes found under '${folder}'.`);
          }
          const lines = notes.map(
            (n) => `${n.path}  (${n.sizeBytes}B, modified ${n.modifiedAt})`,
          );
          return text(lines.join("\n"));
        }

        case "read_note": {
          // Be forgiving at the boundary: a model that saw "alpha" without
          // .md in a listing should not fail. Cheap normalization here beats
          // a failed call round-trip.
          let notePath = requireString(args, "path");
          if (!notePath.endsWith(".md")) notePath += ".md";
          const content = await vault.readNote(notePath);
          return text(content);
        }

        default:
          // Unknown tool = the client asked for something we never advertised.
          // Protocol-level mistake → protocol error (SDK → JSON-RPC -32602).
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      // Re-throw protocol-level mistakes; everything else is tool feedback.
      if (err instanceof Error && err.message.startsWith("Unknown tool:")) throw err;
      if (err instanceof VaultPathError) return toolError(err.message);
      // fs errors (ENOENT, EISDIR, ...) carry a code — surface it readably.
      const msg = err instanceof Error ? `${err.message}` : String(err);
      return toolError(msg);
    }
  });

  return server;
}

/** Success result carrying one text block — the shape models read. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Failed-but-valid request: the model gets the reason and can adapt. */
function toolError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

/** Narrow an unknown argument value with a model-readable complaint. */
function requireString(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new VaultPathError(`Missing required string argument '${key}'`);
  }
  return value;
}
