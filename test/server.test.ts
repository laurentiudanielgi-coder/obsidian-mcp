/**
 * server.test.ts — talks raw JSON-RPC to the built server, like a client would.
 *
 * NOTE — why this test spawns a real process instead of importing
 * `createServer()` and calling handlers directly:
 * Handler-level tests would verify our logic but skip the part we most want
 * to verify: the WIRE. Here we fork `dist/index.js`, write newline-delimited
 * JSON-RPC into its stdin, and parse its stdout — exactly what Claude Desktop
 * does. If the framing, the handshake, or the response shapes are wrong, this
 * test catches it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

let vaultDir: string;
let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (value: any) => void>();

/**
 * Send one JSON-RPC frame: `JSON.stringify(msg)` + "\n".
 * That trailing newline IS the framing for stdio transport — no headers, no
 * Content-Length (that's the *old* LSP-style framing; MCP stdio is line-delimited).
 */
function send(msg: object): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function request(method: string, params: object): { id: number; promise: Promise<any> } {
  const id = nextId++;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  send({ jsonrpc: "2.0", id, method, params });
  return { id, promise };
}

function notify(method: string, params: object): void {
  send({ jsonrpc: "2.0", method, params }); // no `id` = notification → no response ever
}

beforeAll(async () => {
  // Fixture vault: 2 notes + 1 non-note, so vault_info has something real to count.
  vaultDir = await mkdtemp(path.join(tmpdir(), "obsidian-mcp-test-"));
  await mkdir(path.join(vaultDir, "projects"));
  await writeFile(path.join(vaultDir, "inbox.md"), "# Inbox\n");
  await writeFile(path.join(vaultDir, "projects", "alpha.md"), "# Alpha\n");
  await writeFile(path.join(vaultDir, "scratch.txt"), "not a note");

  child = spawn("node", [path.resolve("dist/index.js")], {
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Route each stdout line to whoever is awaiting its response id.
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child.kill();
});

describe("MCP handshake and tools", () => {
  it("completes the initialize handshake", async () => {
    const { promise } = request("initialize", {
      protocolVersion: "2025-06-18", // the spec revision this SDK targets
      capabilities: {}, // client declares ITS features; empty is valid
      clientInfo: { name: "wire-test", version: "0.0.0" },
    });
    const res = await promise;

    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.serverInfo.name).toBe("obsidian-mcp");
    // The capability we declared in server.ts, echoed back for the client.
    expect(res.result.capabilities).toHaveProperty("tools");
  });

  it("lists vault_info", async () => {
    // The spec requires `notifications/initialized` before anything else;
    // the SDK tolerates a missing one, but a well-behaved client sends it.
    notify("notifications/initialized", {});

    const { promise } = request("tools/list", {});
    const res = await promise;

    expect(res.result.tools.map((t: any) => t.name)).toContain("vault_info");
    expect(res.result.tools[0].inputSchema.type).toBe("object");
  });

  it("counts notes in the fixture vault", async () => {
    const { promise } = request("tools/call", {
      name: "vault_info",
      arguments: {},
    });
    const res = await promise;

    // No `error` field + no `isError` flag = success (see server.ts note on
    // the two failure channels).
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain("Markdown notes: 2");
  });

  it("lists notes with vault-relative paths", async () => {
    const { promise } = request("tools/call", { name: "list_notes", arguments: {} });
    const res = await promise;

    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain("inbox.md");
    expect(res.result.content[0].text).toContain("projects/alpha.md");
  });

  it("reads a note, forgiving a missing .md suffix", async () => {
    const withSuffix = request("tools/call", {
      name: "read_note",
      arguments: { path: "projects/alpha.md" },
    });
    const withoutSuffix = request("tools/call", {
      name: "read_note",
      arguments: { path: "projects/alpha" },
    });

    expect((await withSuffix.promise).result.content[0].text).toBe("# Alpha\n");
    expect((await withoutSuffix.promise).result.content[0].text).toBe("# Alpha\n");
  });

  it("reports a missing note as a tool error — a result, NOT a protocol error", async () => {
    const { promise } = request("tools/call", {
      name: "read_note",
      arguments: { path: "ghost.md" },
    });
    const res = await promise;

    expect(res.error).toBeUndefined(); // protocol was fine
    expect(res.result.isError).toBe(true); // the work failed, model gets the reason
    expect(res.result.content[0].text).toMatch(/ENOENT|No such/);
  });

  it("contains traversal attempts as tool errors — never reads outside the vault", async () => {
    const { promise } = request("tools/call", {
      name: "read_note",
      arguments: { path: "../../../../etc/passwd" },
    });
    const res = await promise;

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/escapes the vault/);
  });

  it("searches notes and returns path:line references", async () => {
    const { promise } = request("tools/call", {
      name: "search_notes",
      arguments: { query: "alpha" },
    });
    const res = await promise;

    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toMatch(/projects\/alpha\.md:1: # Alpha/);
  });

  it("creates a note with frontmatter, then reads it back", async () => {
    const create = request("tools/call", {
      name: "create_note",
      arguments: {
        path: "research/new-note",
        content: "# New\n\nbody",
        frontmatter: { tags: ["wip"] },
      },
    });
    expect((await create.promise).result.content[0].text).toBe("Created research/new-note.md");

    const read = request("tools/call", { name: "read_note", arguments: { path: "research/new-note" } });
    expect((await read.promise).result.content[0].text).toContain("# New");

    const fm = request("tools/call", { name: "get_frontmatter", arguments: { path: "research/new-note" } });
    expect(JSON.parse((await fm.promise).result.content[0].text)).toEqual({ tags: ["wip"] });
  });

  it("refuses to silently overwrite on create — a tool error the model can act on", async () => {
    const { promise } = request("tools/call", {
      name: "create_note",
      arguments: { path: "inbox.md", content: "clobber" },
    });
    const res = await promise;

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/already exists/);
  });

  it("edits a note in place (append) and the change is visible to read_note", async () => {
    const edit = request("tools/call", {
      name: "edit_note",
      arguments: { path: "projects/alpha", mode: "append", content: "appended line" },
    });
    expect((await edit.promise).result.isError).toBeUndefined();

    const read = request("tools/call", { name: "read_note", arguments: { path: "projects/alpha.md" } });
    expect((await read.promise).result.content[0].text).toContain("appended line");
  });

  it("moves notes to .trash on delete — and the model finds out if it reads again", async () => {
    const del = request("tools/call", { name: "delete_note", arguments: { path: "inbox.md" } });
    expect((await del.promise).result.content[0].text).toMatch(/\.trash\/inbox\.md/);

    const read = request("tools/call", { name: "read_note", arguments: { path: "inbox.md" } });
    expect((await read.promise).result.isError).toBe(true);
  });

  it("reports backlinks with sources and lines", async () => {
    const setup = request("tools/call", {
      name: "create_note",
      arguments: { path: "links/source", content: "points at [[target]]" },
    });
    await setup.promise;
    await request("tools/call", { name: "create_note", arguments: { path: "links/target", content: "# T" } }).promise;

    const { promise } = request("tools/call", {
      name: "get_backlinks",
      arguments: { path: "links/target" },
    });
    const res = await promise;

    expect(res.result.content[0].text).toContain("links/source.md:1");
    expect(res.result.content[0].text).toContain("points at [[target]]");
  });

  it("moves a note and confirms link repair in the result", async () => {
    const { promise } = request("tools/call", {
      name: "move_note",
      arguments: { from_path: "links/target", to_path: "links/target-renamed" },
    });
    const res = await promise;

    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain("links/target.md → links/target-renamed.md");
    expect(res.result.content[0].text).toMatch(/Updated 1 link/);

    // the source note's link was rewritten to the new name
    const read = request("tools/call", { name: "read_note", arguments: { path: "links/source.md" } });
    expect((await read.promise).result.content[0].text).toContain("[[target-renamed]]");
  });

  it("reports unknown tools as isError results (McpServer behavior)", async () => {
    const { promise } = request("tools/call", { name: "does_not_exist", arguments: {} });
    const res = await promise;

    // Behavioral note: the deprecated low-level `Server` returned unknown
    // tools as a JSON-RPC protocol error (`error`, no `result`). The
    // recommended `McpServer` normalizes them into isError tool results so
    // the model can read the message and react. Same wire method, different
    // envelope semantics — one of the changes the wire tests pin.
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not found/);
  });
});
