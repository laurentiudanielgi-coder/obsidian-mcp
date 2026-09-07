/**
 * server.test.ts — talks raw JSON-RPC to the built server, like a client would.
 *
 * LEARNING NOTE — why this test spawns a real process instead of importing
 * `createServer()` and calling handlers directly:
 * Handler-level tests would verify our logic but skip the part we most want
 * to learn: the WIRE. Here we fork `dist/index.js`, write newline-delimited
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
      clientInfo: { name: "learning-test", version: "0.0.0" },
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

  it("rejects unknown tools as a protocol error", async () => {
    const { promise } = request("tools/call", { name: "does_not_exist", arguments: {} });
    const res = await promise;

    // Protocol error: response carries `error`, NOT `result`. Contrast with
    // how a *failed* vault_info would look (result.isError = true).
    expect(res.error).toBeDefined();
    expect(res.result).toBeUndefined();
  });
});
