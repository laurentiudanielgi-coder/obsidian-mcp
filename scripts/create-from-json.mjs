#!/usr/bin/env node
/**
 * create-from-json.mjs — push an EXACT payload through the raw JSON-RPC pipe.
 *
 * The size probe generates synthetic content; this one takes the precise
 * argument object a client (e.g. Claude Desktop) showed you, so a hang in
 * the client vs. a hang in the server can be compared byte-for-byte.
 *
 * Usage: node scripts/create-from-json.mjs note.json [vaultPath]
 *   note.json = {"path": "...", "content": "...", "frontmatter": {...}}
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [file, vaultArg] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/create-from-json.mjs note.json [vaultPath]");
  process.exit(1);
}
const vault = vaultArg ?? process.env.OBSIDIAN_VAULT_PATH;
if (!vault) {
  console.error("No vault: pass vaultPath or set OBSIDIAN_VAULT_PATH");
  process.exit(1);
}
const args = JSON.parse(await readFile(file, "utf8"));
console.log(`Pushing note '${args.path}' (${(args.content ?? "").length} chars content)...`);

const frames = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "json-probe", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_note", arguments: args } },
];

const child = spawn("node", [path.resolve("dist/index.js")], {
  env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  stdio: ["pipe", "pipe", "inherit"],
});

const start = Date.now();
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) {
      const ms = Date.now() - start;
      console.log(`create_note → ${ms}ms: ${msg.result?.content?.[0]?.text ?? JSON.stringify(msg)}`);
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(frames.map((f) => JSON.stringify(f) + "\n").join(""));
