/**
 * server.ts — the MCP protocol layer.
 *
 * NOTE — why the *low-level* `Server` class:
 * The SDK ships two layers:
 *   - `McpServer` (high-level): register tools with one call, schemas handled
 *     for you. Convenient, but the protocol becomes invisible.
 *   - `Server` (low-level): YOU register a handler per JSON-RPC method, keyed
 *     by the exact method name from the spec ("tools/list", "tools/call").
 * We use the low-level one on purpose: every protocol concept
 * stays visible in code.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { Vault, VaultPathError, type EditRequest } from "./vault.js";

/**
 * NOTE — the MCP lifecycle (what happens before any tool runs):
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
    { name: "obsidian-mcp", version: "0.4.2" },
    { capabilities: { tools: {} } },
  );

  // The fs layer from milestone 2. Every tool below goes through it — no
  // handler touches a path directly.
  const vault = new Vault(config.vaultPath);

  /**
   * NOTE — "tools/list" is metadata, not execution:
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
          annotations: { readOnlyHint: true },
          description:
            "Report the vault root path and how many markdown notes it contains. " +
            "Use this first to confirm the vault is mounted and readable.",
          inputSchema: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "list_notes",
          annotations: { readOnlyHint: true },
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
          annotations: { readOnlyHint: true },
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
        {
          name: "search_notes",
          annotations: { readOnlyHint: true },
          description:
            "Full-text search across all notes. Default is case-insensitive substring " +
            "matching; set regex=true to treat query as a regular expression. " +
            "Returns path, line number and the matching line, capped at 50 hits.",
          inputSchema: {
            type: "object" as const,
            properties: {
              query: { type: "string", description: "Text to search for" },
              regex: { type: "boolean", description: "Treat query as a regular expression" },
              folder: { type: "string", description: "Optional subfolder to restrict the search" },
            },
            required: ["query"],
          },
        },
        {
          name: "get_frontmatter",
          annotations: { readOnlyHint: true },
          description:
            "Read a note's YAML frontmatter (its properties: tags, dates, custom " +
            "fields) as JSON. Cheaper than read_note when you only need metadata.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Vault-relative note path" },
            },
            required: ["path"],
          },
        },
        {
          name: "create_note",
          description:
            "Create a new note. Fails if it already exists unless overwrite=true. " +
            "Parent folders are created automatically. Pass `frontmatter` to have " +
            "YAML properties generated; `content` is the markdown body.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Vault-relative note path (.md optional)" },
              content: { type: "string", description: "Markdown body of the note" },
              frontmatter: {
                type: "object",
                description: "Optional YAML properties, e.g. {\"tags\": [\"research\"]}",
              },
              overwrite: { type: "boolean", description: "Replace an existing note" },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "edit_note",
          description:
            "Edit an existing note in place. Modes: 'append'/'prepend' content " +
            "(prepend lands after frontmatter); 'find_replace' all occurrences of " +
            "find→replace (fails if find is absent); 'replace_section' swaps " +
            "everything under `heading` (subsections included) for `content`.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Vault-relative note path" },
              mode: {
                type: "string",
                enum: ["append", "prepend", "find_replace", "replace_section"],
              },
              content: { type: "string", description: "Text for append/prepend/replace_section" },
              find: { type: "string", description: "Text to find (find_replace)" },
              replace: { type: "string", description: "Replacement text (find_replace)" },
              heading: { type: "string", description: "Exact heading text (replace_section)" },
            },
            required: ["path", "mode"],
          },
        },
        {
          name: "delete_note",
          description:
            "Move a note to the vault's .trash folder. NEVER a permanent delete — " +
            "the note can be restored from .trash. Folders are refused, but " +
            "folders left empty by the delete are removed automatically.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Vault-relative note path" },
            },
            required: ["path"],
          },
        },
        {
          name: "get_backlinks",
          annotations: { readOnlyHint: true },
          description:
            "List notes that link TO a given note (wikilinks, embeds and relative " +
            "markdown links). Use before editing or deleting to understand what " +
            "references it, or to follow the knowledge graph backwards.",
          inputSchema: {
            type: "object" as const,
            properties: {
              path: { type: "string", description: "Vault-relative note path" },
            },
            required: ["path"],
          },
        },
        {
          name: "move_note",
          description:
            "Move or rename a note (folders created automatically) and automatically " +
            "update all links across the vault that pointed at its old location: " +
            "wikilinks, embeds and relative markdown links. Emptied source " +
            "folders are pruned. Prefer this over create+delete for renaming.",
          inputSchema: {
            type: "object" as const,
            properties: {
              from_path: { type: "string", description: "Current vault-relative path" },
              to_path: { type: "string", description: "New vault-relative path" },
            },
            required: ["from_path", "to_path"],
          },
        },
      ],
    };
  });

  /**
   * NOTE — "tools/call" is where the model's request lands:
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

    // stderr-only observability: when a client hangs, this line is how we
    // know whether the request ever REACHED us. Check the caller's MCP log
    // (e.g. ~/Library/Logs/Claude/mcp*.log) for it.
    console.error(`[obsidian-mcp] tools/call ${name}`);

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
          const content = await vault.readNote(requireString(args, "path"));
          return text(content);
        }

        case "search_notes": {
          const query = requireString(args, "query");
          const { matches, total, truncated } = await vault.searchNotes(query, {
            regex: args?.regex === true,
            folder: typeof args?.folder === "string" ? args.folder : undefined,
          });
          if (total === 0) return text(`No matches for '${query}'.`);
          const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
          if (truncated) {
            lines.push(`(showing ${matches.length} of ${total} matches — narrow the query or folder)`);
          }
          return text(lines.join("\n"));
        }

        case "get_frontmatter": {
          const data = await vault.getFrontmatter(requireString(args, "path"));
          return text(JSON.stringify(data, null, 2));
        }

        case "create_note": {
          const rel = await vault.createNote(requireString(args, "path"), requireString(args, "content"), {
            overwrite: args?.overwrite === true,
            frontmatter:
              args?.frontmatter && typeof args.frontmatter === "object" && !Array.isArray(args.frontmatter)
                ? (args.frontmatter as Record<string, unknown>)
                : undefined,
          });
          return text(`Created ${rel}`);
        }

        case "edit_note": {
          const result = await vault.editNote(requireString(args, "path"), toEditRequest(args));
          return text(result);
        }

        case "delete_note": {
          const trashPath = await vault.deleteNote(requireString(args, "path"));
          return text(`Moved to ${trashPath} (recoverable from the vault's .trash folder)`);
        }

        case "get_backlinks": {
          const backlinks = await vault.getBacklinks(requireString(args, "path"));
          if (backlinks.length === 0) return text("No backlinks found.");
          const lines = backlinks.map((bl) => `${bl.source}:${bl.line} — ${bl.snippet}`);
          return text(`${backlinks.length} backlink(s):\n${lines.join("\n")}`);
        }

        case "move_note": {
          const result = await vault.moveNote(requireString(args, "from_path"), requireString(args, "to_path"));
          return text(
            `Moved ${result.from} → ${result.to}\n` +
              `Updated ${result.linksUpdated} link(s) in ${result.filesTouched} file(s).`,
          );
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

/**
 * Map the free-form JSON arguments onto the EditRequest union. Each mode's
 * required fields are enforced here with tool-error complaints — the model
 * gets told exactly what's missing, per mode, instead of a generic failure.
 */
function toEditRequest(args: Record<string, unknown> | undefined): EditRequest {
  const mode = requireString(args, "mode");
  switch (mode) {
    case "append":
    case "prepend":
      return { mode, content: requireString(args, "content") };
    case "find_replace":
      return { mode, find: requireString(args, "find"), replace: requireString(args, "replace") };
    case "replace_section":
      return { mode, heading: requireString(args, "heading"), content: requireString(args, "content") };
    default:
      throw new VaultPathError(
        `Unknown mode '${mode}'. Valid modes: append, prepend, find_replace, replace_section`,
      );
  }
}
