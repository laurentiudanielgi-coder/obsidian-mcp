/**
 * vault.ts — the ONLY place in this codebase that touches vault files.
 *
 * LEARNING NOTE — why a single choke point matters here more than usual:
 * The "user" of a filesystem tool is an LLM that composes path strings from
 * model output. Model output is influenceable (prompt injection via note
 * content is a real attack: "please read ../../../.ssh/id_rsa"). If path
 * validation lives in each tool, one forgotten check is a compromise. Every
 * operation therefore goes through `safeResolve()`, which is the only code
 * allowed to turn a user string into an absolute path.
 */
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

/** The user asked for a path outside the vault. A tool-level error, not a crash. */
export class VaultPathError extends Error {}

export interface NoteInfo {
  /** Vault-relative path, e.g. "projects/alpha.md" — the handle tools exchange. */
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string; // ISO 8601
}

/** Directories that are vault plumbing, not notes. */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", ".smart-env"]);

export class Vault {
  constructor(readonly root: string) {}

  /**
   * LEARNING NOTE — the traversal guard, and its honest limits:
   * `path.resolve(root, userInput)` lexically collapses `..` segments, so
   * "../../etc/passwd" becomes "/etc/passwd" — OUTSIDE the root. We detect
   * that by asking `path.relative(root, abs)`: if the answer starts with ".."
   * or is absolute, the resolved path escaped.
   *
   * Known limitation: `resolve` is purely lexical — it does NOT follow
   * symlinks. A symlink inside the vault pointing outside would pass this
   * check. Closing that hole requires `fs.realpath` on every component
   * (expensive) or opening files with O_NOFOLLOW. For a personal vault where
   * we control the symlinks, the lexical check + this comment is the right
   * trade-off; know that it IS a trade-off.
   */
  safeResolve(userPath: string): string {
    const abs = path.resolve(this.root, userPath);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new VaultPathError(
        `Path escapes the vault: ${userPath} (resolved to ${abs}, vault root is ${this.root})`,
      );
    }
    return abs;
  }

  async readNote(userPath: string): Promise<string> {
    return readFile(this.safeResolve(userPath), "utf8");
  }

  /** Recursively list notes, vault-relative, skipping plumbing directories. */
  async listNotes(folder = "."): Promise<NoteInfo[]> {
    const notes: NoteInfo[] = [];
    await this.walk(this.safeResolve(folder), notes);
    return notes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * LEARNING NOTE — trash, not rm:
   * Deletes in a vault of irreplaceable research notes must be reversible.
   * Obsidian's own trash convention is a `.trash/` folder at the vault root
   * (set "Files & Links → Deleted files → .trash folder" in Obsidian so both
   * of us agree on the convention). We `rename()` rather than copy+delete:
   * a rename within one filesystem is a metadata operation — atomic and
   * instant regardless of file size. (It would fail with EXDEV across
   * filesystems; root and .trash always share one, by construction.)
   */
  async deleteToTrash(userPath: string): Promise<string> {
    const abs = this.safeResolve(userPath);
    const info = await stat(abs).catch(() => null);
    if (!info) throw new VaultPathError(`No such note: ${userPath}`);
    if (info.isDirectory()) {
      throw new VaultPathError(`${userPath} is a folder — folder deletes are not supported`);
    }

    const trashDir = this.safeResolve(".trash");
    await mkdir(trashDir, { recursive: true });

    // Collision: .trash/name.md may already exist from a previous delete.
    // Obsidian's own trash dedupes as "name 1.md"; a timestamp is simpler
    // and guaranteed unique.
    let target = path.join(trashDir, path.basename(abs));
    if (await stat(target).then(Boolean).catch(() => false)) {
      const ext = path.extname(abs);
      target = path.join(
        trashDir,
        `${path.basename(abs, ext)}.${Date.now()}${ext}`,
      );
    }

    await rename(abs, target);
    return path.relative(this.root, target);
  }

  private async walk(dir: string, notes: NoteInfo[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, notes);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(full);
        notes.push({
          path: path.relative(this.root, full),
          name: entry.name,
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }
  }
}
