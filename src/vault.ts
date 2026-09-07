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
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

/** The user asked for a path outside the vault. A tool-level error, not a crash. */
export class VaultPathError extends Error {}

export interface NoteInfo {
  /** Vault-relative path, e.g. "projects/alpha.md" — the handle tools exchange. */
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string; // ISO 8601
}

export interface SearchMatch {
  path: string;
  /** 1-based line number, editor convention. */
  line: number;
  text: string;
}

/**
 * A discriminated union by `mode` — one tool, but each mode demands different
 * arguments. TypeScript makes an invalid combination unrepresentable; the
 * zod-free server layer maps its JSON Schema onto this by hand (see server.ts).
 */
export type EditRequest =
  | { mode: "append"; content: string }
  | { mode: "prepend"; content: string }
  | { mode: "find_replace"; find: string; replace: string }
  | { mode: "replace_section"; heading: string; content: string };

/** Join two blocks of markdown with exactly one blank line, whatever garbage the caller sent. */
function joinBlocks(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join("\n\n") + "\n";
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
    return readFile(this.safeResolve(this.normalize(userPath)), "utf8");
  }

  /**
   * LEARNING NOTE — normalize at the boundary, once:
   * Models drop the ".md" constantly (a listing showed "alpha", the model
   * asks for "alpha"). Normalizing HERE means read/create/edit/delete all
   * behave identically, instead of each tool remembering to do it.
   */
  private normalize(userPath: string): string {
    return userPath.endsWith(".md") ? userPath : `${userPath}.md`;
  }

  /** Parse (but don't modify) a note's YAML frontmatter. Returns {} when absent. */
  async getFrontmatter(userPath: string): Promise<Record<string, unknown>> {
    const raw = await this.readNote(userPath);
    return (matter(raw).data ?? {}) as Record<string, unknown>;
  }

  /**
   * Full-text search across notes.
   * Substring mode is case-insensitive (research terms vary in casing);
   * regex mode passes the query to RegExp verbatim — the caller owns syntax.
   * Results are capped so a query like "the" can't flood the model's context
   * window; `truncated` says so honestly instead of silently dropping.
   */
  async searchNotes(
    query: string,
    opts: { regex?: boolean; folder?: string; limit?: number } = {},
  ): Promise<{ matches: SearchMatch[]; total: number; truncated: boolean }> {
    const limit = opts.limit ?? 50;
    const matcher: (line: string) => boolean = opts.regex
      ? (line) => new RegExp(query).test(line)
      : (line) => line.toLowerCase().includes(query.toLowerCase());

    const matches: SearchMatch[] = [];
    let total = 0;
    for (const file of await this.collectMarkdown(opts.folder ?? ".")) {
      const lines = (await readFile(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!matcher(lines[i])) continue;
        total++;
        if (matches.length < limit) {
          matches.push({
            path: path.relative(this.root, file),
            line: i + 1,
            text: lines[i].trim(),
          });
        }
      }
    }
    return { matches, total, truncated: total > matches.length };
  }

  /**
   * Create a note. The `wx` flag is the whole overwrite story: the kernel
   * guarantees create-fails-if-exists atomically — no exists?-then-write race.
   * Optional `frontmatter` object is serialized to YAML for the caller.
   */
  async createNote(
    userPath: string,
    content: string,
    opts: { overwrite?: boolean; frontmatter?: Record<string, unknown> } = {},
  ): Promise<string> {
    const rel = this.normalize(userPath);
    const abs = this.safeResolve(rel);
    await mkdir(path.dirname(abs), { recursive: true });

    const body = opts.frontmatter
      ? matter.stringify(content.trimStart(), opts.frontmatter)
      : content;

    try {
      await writeFile(abs, body, { flag: opts.overwrite ? "w" : "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new VaultPathError(`Note already exists: ${rel} (pass overwrite=true to replace)`);
      }
      throw err;
    }
    return rel;
  }

  /**
   * LEARNING NOTE — edits are read-modify-write, and that's OK here:
   * A single-user local vault has no concurrent writers to lose a race
   * against. (A multi-user server would want locking or content hashing.)
   * Frontmatter is respected: prepend inserts AFTER the YAML block, never
   * inside it — an edit that silently corrupts frontmatter is worse than one
   * that refuses.
   */
  async editNote(userPath: string, edit: EditRequest): Promise<string> {
    const abs = this.safeResolve(this.normalize(userPath));
    const original = await readFile(abs, "utf8");

    switch (edit.mode) {
      case "append": {
        await writeFile(abs, joinBlocks(original, edit.content));
        return "appended content at end of note";
      }
      case "prepend": {
        const fm = original.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        const updated = fm
          ? fm[0] + joinBlocks(edit.content, original.slice(fm[0].length))
          : joinBlocks(edit.content, original);
        await writeFile(abs, updated);
        return "prepended content after frontmatter";
      }
      case "find_replace": {
        const count = original.split(edit.find).length - 1;
        if (count === 0) {
          throw new VaultPathError(`Text not found in note: '${edit.find}'`);
        }
        await writeFile(abs, original.split(edit.find).join(edit.replace));
        return `replaced ${count} occurrence(s)`;
      }
      case "replace_section": {
        return this.replaceSection(abs, edit.heading, edit.content);
      }
    }
  }

  /**
   * Replace everything under a heading (exclusive of the heading itself) up
   * to the next heading of the SAME or higher level — so subsections belong
   * to the section and get replaced with it. On a miss, we list the headings
   * that DO exist: the model can self-correct on the next call instead of
   * guessing. That error message is tool UX, not decoration.
   */
  private async replaceSection(abs: string, heading: string, content: string): Promise<string> {
    const original = await readFile(abs, "utf8");
    const lines = original.split("\n");
    const headingRe = /^(#{1,6})\s+(.*?)\s*$/;

    const wanted = heading.trim();
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(headingRe);
      if (m && m[2] === wanted) {
        start = i;
        level = m[1].length;
        break;
      }
    }
    if (start === -1) {
      const headings = lines
        .map((l) => l.match(headingRe)?.[0])
        .filter((h): h is string => Boolean(h))
        .join(", ");
      throw new VaultPathError(
        `Heading '${wanted}' not found. Available headings: ${headings || "none"}`,
      );
    }

    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      const m = lines[j].match(headingRe);
      if (m && m[1].length <= level) {
        end = j;
        break;
      }
    }

    lines.splice(start + 1, end - start - 1, "", ...content.trimEnd().split("\n"), "");
    await writeFile(abs, lines.join("\n"));
    return `replaced section '${heading}'`;
  }

  /** delete_note tool target — see deleteToTrash for the semantics. */
  async deleteNote(userPath: string): Promise<string> {
    return this.deleteToTrash(this.normalize(userPath));
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

  /** All note files under a folder, absolute paths, for content-level scans. */
  private async collectMarkdown(folder: string): Promise<string[]> {
    const out: string[] = [];
    const walkPaths = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkPaths(full);
        else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
      }
    };
    await walkPaths(this.safeResolve(folder));
    return out.sort();
  }
}
