#!/usr/bin/env node
/**
 * big-create-test.mjs — bypass Claude entirely and measure the server directly.
 *
 * Speaks raw JSON-RPC to the built server and times a create_note with a
 * payload of arbitrary size. If this responds instantly at 9,000 chars but
 * Claude Desktop hangs on the same call, the ceiling is client-side, proven.
 *
 * Usage: node scripts/big-create-test.mjs <size-in-chars> [vaultPath]
 * Defaults: size 2500, vault = OBSIDIAN_VAULT_PATH or /tmp big-create vault.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const size = Number(process.argv[2] ?? 2500);
const vault = process.argv[3] ?? process.env.OBSIDIAN_VAULT_PATH ?? (await mkdtemp(path.join(tmpdir(), "bigcreate-")));

const content = "Lorem ipsum dolor sit amet. ".repeat(Math.ceil(size / 28)).slice(0, size);

const frames = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "size-probe", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create_note",
      arguments: {
        path: "Finanțe/size-probe.md",
        frontmatter: { tags: ["probe"], sursă: "script", status: "draft" },
        content: `# Size probe (${size} chars)\n\n${content}`,
      },
    },
  },
];

const child = spawn("node", [path.resolve("dist/index.js")], {
  env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  stdio: ["pipe", "pipe", "inherit"],
});

const start = Date.now();
child.stdout.on("data", async (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) {
      const ms = Date.now() - start;
      const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg);
      console.log(`create_note with ~${size} chars → ${ms}ms: ${text}`);
      child.kill();
      if (vault.startsWith(tmpdir())) await rm(vault, { recursive: true, force: true });
      process.exit(0);
    }
  }
});

child.stdin.write(frames.map((f) => JSON.stringify(f) + "\n").join(""));
