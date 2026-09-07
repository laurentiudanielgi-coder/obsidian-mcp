/**
 * server.ts — the MCP protocol layer.
 *
 * NOTE — which SDK layer, and why:
 * The SDK ships two layers. The low-level `Server` class (handlers per
 * JSON-RPC method, written by hand) is deprecated as of SDK 1.30 in favor of
 * `McpServer` + `registerTool`. We follow the recommendation — but the
 * protocol itself does not move: `McpServer` is a convenience wrapper that
 * still speaks the exact same JSON-RPC over the same transport. Our
 * integration tests (test/server.test.ts) speak RAW JSON-RPC to the built
 * process, so any SDK refactor that changes the wire fails the suite. Tool
 * behavior and error semantics stay pinned there, not in this file.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { Vault, type EditRequest } from "./vault.js";

export function createServer(config: Config): McpServer {
  // The fs layer. Every tool below goes through it — no handler touches a
  // path directly.
  const vault = new Vault(config.vaultPath);

  const server = new McpServer({ name: "obsidian-mcp", version: "0.5.0" });

  /**
   * NOTE — the two failure channels, kept explicit:
   * The spec separates (1) PROTOCOL errors — the request spoke the protocol
   * wrong; JSON-RPC error response, no result — from (2) TOOL results with
   * `isError: true` — a normal response saying the *work* failed, which the
   * model reads and reacts to. SDK internals decide (1); we own (2) with this
   * wrapper so the contract holds regardless of SDK version. File-not-found
   * and friends are (2): the request was valid, the operation failed.
   */
  const guarded =
    <A>(fn: (args: A) => Promise<{ content: { type: "text"; text: string }[] }>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
    };

  const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

  // ── Reads (readOnlyHint: clients may skip approval prompts) ─────────────

  server.registerTool(
    "vault_info",
    {
      title: "Vault info",
      description:
        "Report the vault root path and how many markdown notes it contains. " +
        "Use this first to confirm the vault is mounted and readable.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    guarded(async () => {
      const notes = await vault.listNotes();
      return text(`Vault root: ${config.vaultPath}\nMarkdown notes: ${notes.length}`);
    }),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List markdown notes in the vault (or a subfolder), newest info included. " +
        "Returns vault-relative paths — use those in read_note.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional subfolder to list, vault-relative (e.g. 'projects')"),
      },
    },
    guarded(async ({ folder }) => {
      const notes = await vault.listNotes(folder ?? ".");
      if (notes.length === 0) return text(`No notes found under '${folder ?? "."}'.`);
      return text(
        notes.map((n) => `${n.path}  (${n.sizeBytes}B, modified ${n.modifiedAt})`).join("\n"),
      );
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description:
        "Read the full markdown content of one note. `path` is vault-relative " +
        "(from list_notes), e.g. 'projects/alpha.md'. The .md suffix is optional.",
      annotations: { readOnlyHint: true },
      inputSchema: { path: z.string().min(1).describe("Vault-relative note path") },
    },
    guarded(async ({ path: notePath }) => text(await vault.readNote(notePath))),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Full-text search across all notes. Default is case-insensitive substring " +
        "matching; set regex=true to treat query as a regular expression. " +
        "Returns path, line number and the matching line, capped at 50 hits.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("Text to search for"),
        regex: z.boolean().optional().describe("Treat query as a regular expression"),
        folder: z.string().optional().describe("Optional subfolder to restrict the search"),
      },
    },
    guarded(async ({ query, regex, folder }) => {
      const { matches, total, truncated } = await vault.searchNotes(query, { regex, folder });
      if (total === 0) return text(`No matches for '${query}'.`);
      const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
      if (truncated) {
        lines.push(`(showing ${matches.length} of ${total} matches — narrow the query or folder)`);
      }
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "get_frontmatter",
    {
      title: "Get frontmatter",
      description:
        "Read a note's YAML frontmatter (its properties: tags, dates, custom " +
        "fields) as JSON. Cheaper than read_note when you only need metadata.",
      annotations: { readOnlyHint: true },
      inputSchema: { path: z.string().min(1).describe("Vault-relative note path") },
    },
    guarded(async ({ path: notePath }) =>
      text(JSON.stringify(await vault.getFrontmatter(notePath), null, 2)),
    ),
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get backlinks",
      description:
        "List notes that link TO a given note (wikilinks, embeds and relative " +
        "markdown links). Use before editing or deleting to understand what " +
        "references it, or to follow the knowledge graph backwards.",
      annotations: { readOnlyHint: true },
      inputSchema: { path: z.string().min(1).describe("Vault-relative note path") },
    },
    guarded(async ({ path: notePath }) => {
      const backlinks = await vault.getBacklinks(notePath);
      if (backlinks.length === 0) return text("No backlinks found.");
      const lines = backlinks.map((bl) => `${bl.source}:${bl.line} — ${bl.snippet}`);
      return text(`${backlinks.length} backlink(s):\n${lines.join("\n")}`);
    }),
  );

  // ── Writes ──────────────────────────────────────────────────────────────

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description:
        "Create a new note. Fails if it already exists unless overwrite=true. " +
        "Parent folders are created automatically. Pass `frontmatter` to have " +
        "YAML properties generated; `content` is the markdown body.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path (.md optional)"),
        content: z.string().describe("Markdown body of the note"),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional YAML properties, e.g. {\"tags\": [\"research\"]}"),
        overwrite: z.boolean().optional().describe("Replace an existing note"),
      },
    },
    guarded(async ({ path: notePath, content, frontmatter, overwrite }) => {
      const rel = await vault.createNote(notePath, content, { overwrite, frontmatter });
      return text(`Created ${rel}`);
    }),
  );

  /**
   * One tool, four shapes of arguments. The discriminated logic lives in a
   * superRefine so the model gets a per-mode, human-readable complaint
   * ("'find' is required for mode 'find_replace'") instead of a generic
   * validation failure.
   */
  const EditNoteArgs = z
    .object({
      path: z.string().min(1).describe("Vault-relative note path"),
      mode: z.enum(["append", "prepend", "find_replace", "replace_section"]),
      content: z.string().optional().describe("Text for append/prepend/replace_section"),
      find: z.string().optional().describe("Text to find (find_replace)"),
      replace: z.string().optional().describe("Replacement text (find_replace)"),
      heading: z.string().optional().describe("Exact heading text (replace_section)"),
    })
    .superRefine((v, ctx) => {
      const missing = (key: string) =>
        ctx.addIssue({
          code: "custom",
          message: `'${key}' is required for mode '${v.mode}'`,
          path: [key],
        });
      if (v.mode === "append" || v.mode === "prepend") {
        if (v.content === undefined) missing("content");
      } else if (v.mode === "find_replace") {
        if (v.find === undefined) missing("find");
        if (v.replace === undefined) missing("replace");
      } else if (v.mode === "replace_section") {
        if (v.heading === undefined) missing("heading");
        if (v.content === undefined) missing("content");
      }
    });

  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Edit an existing note in place. Modes: 'append'/'prepend' content " +
        "(prepend lands after frontmatter); 'find_replace' all occurrences of " +
        "find→replace (fails if find is absent); 'replace_section' swaps " +
        "everything under `heading` (subsections included) for `content`.",
      inputSchema: EditNoteArgs.shape,
    },
    guarded(async ({ path: notePath, mode, content, find, replace, heading }) => {
      const edit: EditRequest =
        mode === "append" || mode === "prepend"
          ? { mode, content: content! }
          : mode === "find_replace"
            ? { mode, find: find!, replace: replace! }
            : { mode, heading: heading!, content: content! };
      return text(await vault.editNote(notePath, edit));
    }),
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description:
        "Move a note to the vault's .trash folder. NEVER a permanent delete — " +
        "the note can be restored from .trash. Folders are refused, but " +
        "folders left empty by the delete are removed automatically.",
      inputSchema: { path: z.string().min(1).describe("Vault-relative note path") },
    },
    guarded(async ({ path: notePath }) => {
      const trashPath = await vault.deleteNote(notePath);
      return text(`Moved to ${trashPath} (recoverable from the vault's .trash folder)`);
    }),
  );

  server.registerTool(
    "move_note",
    {
      title: "Move note",
      description:
        "Move or rename a note (folders created automatically) and automatically " +
        "update all links across the vault that pointed at its old location: " +
        "wikilinks, embeds and relative markdown links. Emptied source folders " +
        "are pruned. Prefer this over create+delete for renaming.",
      inputSchema: {
        from_path: z.string().min(1).describe("Current vault-relative path"),
        to_path: z.string().min(1).describe("New vault-relative path"),
      },
    },
    guarded(async ({ from_path, to_path }) => {
      const result = await vault.moveNote(from_path, to_path);
      return text(
        `Moved ${result.from} → ${result.to}\n` +
          `Updated ${result.linksUpdated} link(s) in ${result.filesTouched} file(s).`,
      );
    }),
  );

  return server;
}
