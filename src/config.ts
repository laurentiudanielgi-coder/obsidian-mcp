/**
 * config.ts — where the server learns which vault to operate on.
 *
 * LEARNING NOTE — how an MCP server gets configured:
 * An MCP server does not "install itself" anywhere. It is spawned as a child
 * process by the MCP client (Claude Desktop, opencode, ...). The only channels
 * the client has to pass settings to us are:
 *   1. command-line arguments  (the `args` array in the client config)
 *   2. environment variables   (the `environment` map in the client config)
 *   3. a config file we invent (overkill for one setting)
 *
 * We pick the env var (`OBSIDIAN_VAULT_PATH`) because it is the convention the
 * official reference servers use, and it keeps the client config identical
 * across clients.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

export interface Config {
  /** Absolute path to the Obsidian vault root. All file operations must stay inside it. */
  vaultPath: string;
}

/** Thrown when the environment does not give us a usable vault path. */
export class ConfigError extends Error {}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const raw = env.OBSIDIAN_VAULT_PATH;
  if (!raw) {
    throw new ConfigError(
      "OBSIDIAN_VAULT_PATH is not set. Point it at your vault, e.g. OBSIDIAN_VAULT_PATH=~/Documents/MyVault",
    );
  }

  // Expand a leading `~` ourselves: env vars arrive unexpanded because *we*
  // are the shell's child — there is no shell to do it for us.
  const expanded = raw.startsWith("~") ? path.join(env.HOME ?? "", raw.slice(1)) : raw;
  const vaultPath = path.resolve(expanded);

  const info = await stat(vaultPath).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new ConfigError(`Vault path does not exist or is not a directory: ${vaultPath}`);
  }

  return { vaultPath };
}
