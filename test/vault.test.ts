/**
 * vault.test.ts — unit tests for the filesystem layer, against a real temp dir.
 *
 * Deliberately NOT mocked: the whole point of this layer is precise interaction
 * with a real filesystem (traversal, rename semantics, dot-dirs). Mocking fs
 * here would test the mock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Vault, VaultPathError } from "../src/vault.js";

let root: string;
let vault: Vault;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "obsidian-vault-"));
  await mkdir(path.join(root, ".obsidian"));
  await mkdir(path.join(root, "projects"));
  await writeFile(path.join(root, "inbox.md"), "# Inbox\n");
  await writeFile(path.join(root, "projects", "alpha.md"), "# Alpha\n");
  await writeFile(path.join(root, ".obsidian", "app.json"), "{}");
  vault = new Vault(root);
});

describe("safeResolve", () => {
  it("allows normal relative paths", () => {
    expect(vault.safeResolve("projects/alpha.md")).toBe(path.join(root, "projects/alpha.md"));
    expect(vault.safeResolve(".")).toBe(root);
  });

  it("rejects .. escapes", () => {
    expect(() => vault.safeResolve("../outside.md")).toThrow(VaultPathError);
    expect(() => vault.safeResolve("projects/../../escape.md")).toThrow(VaultPathError);
  });

  it("rejects absolute paths — resolve() discards the vault root entirely", () => {
    // path.resolve(root, "/etc/passwd") === "/etc/passwd". The guard must catch it.
    expect(() => vault.safeResolve("/etc/passwd")).toThrow(VaultPathError);
  });
});

describe("listNotes", () => {
  it("lists notes vault-relative, skipping dot dirs", async () => {
    const notes = await vault.listNotes();
    expect(notes.map((n) => n.path).sort()).toEqual(["inbox.md", "projects/alpha.md"]);
    // And crucially NOT ".obsidian/app.json" — plumbing stays invisible.
  });

  it("lists within a subfolder only", async () => {
    const notes = await vault.listNotes("projects");
    expect(notes.map((n) => n.path)).toEqual(["projects/alpha.md"]);
  });

  it("rejects folder traversal too", async () => {
    await expect(vault.listNotes("../")).rejects.toThrow(VaultPathError);
  });
});

describe("readNote", () => {
  it("reads a note", async () => {
    expect(await vault.readNote("inbox.md")).toBe("# Inbox\n");
  });

  it("errors on missing notes", async () => {
    await expect(vault.readNote("nope.md")).rejects.toThrow(/ENOENT/);
  });
});

describe("deleteToTrash", () => {
  it("moves the note into .trash and returns the trash-relative location", async () => {
    await writeFile(path.join(root, "doomed.md"), "# bye\n");
    const trashPath = await vault.deleteToTrash("doomed.md");

    expect(trashPath).toMatch(/^\.trash\/doomed\.md$/);
    await expect(readFile(path.join(root, "doomed.md"))).rejects.toThrow(/ENOENT/);
    expect(await readFile(path.join(root, trashPath), "utf8")).toBe("# bye\n");
  });

  it("dedupes collisions with a timestamp, losing nothing", async () => {
    await writeFile(path.join(root, "dupe.md"), "first");
    await vault.deleteToTrash("dupe.md");
    await writeFile(path.join(root, "dupe.md"), "second");
    const second = await vault.deleteToTrash("dupe.md");

    expect(second).not.toBe(".trash/dupe.md"); // timestamped
    expect(await readFile(path.join(root, ".trash", "dupe.md"), "utf8")).toBe("first");
    expect(await readFile(path.join(root, second), "utf8")).toBe("second");
  });

  it("refuses to delete folders", async () => {
    await expect(vault.deleteToTrash("projects")).rejects.toThrow(VaultPathError);
  });

  it("refuses to trash the .trash itself or paths outside the vault", async () => {
    await expect(vault.deleteToTrash("../anything")).rejects.toThrow(VaultPathError);
  });
});

describe("searchNotes", () => {
  beforeAll(async () => {
    await writeFile(path.join(root, "searchable.md"), "Alpha doubles as a needle\nquiet line\nNEEDLE again\n");
  });

  it("finds matches case-insensitively with 1-based line numbers", async () => {
    const { matches, total, truncated } = await vault.searchNotes("needle");
    expect(total).toBe(2);
    expect(truncated).toBe(false);
    expect(matches).toEqual([
      { path: "searchable.md", line: 1, text: "Alpha doubles as a needle" },
      { path: "searchable.md", line: 3, text: "NEEDLE again" },
    ]);
  });

  it("supports regex mode, verbatim", async () => {
    const { matches } = await vault.searchNotes("^NEEDLE", { regex: true });
    expect(matches).toHaveLength(1);
    expect(matches[0].line).toBe(3);
  });

  it("restricts to a folder and reports truncation honestly", async () => {
    const project = path.join(root, "projects", "many.md");
    await writeFile(project, Array.from({ length: 30 }, (_, i) => `hit ${i}`).join("\n"));
    const { matches, total, truncated } = await vault.searchNotes("hit", { folder: "projects", limit: 5 });
    expect(total).toBe(30);
    expect(matches).toHaveLength(5);
    expect(truncated).toBe(true);
    expect(matches.every((m) => m.path.startsWith("projects/"))).toBe(true);
  });

  it("collects markdown across nested folders for content scans", async () => {
    const { total } = await vault.searchNotes("Alpha");
    expect(total).toBe(2); // alpha.md heading + searchable.md first line
  });
});

describe("getFrontmatter", () => {
  it("parses YAML properties", async () => {
    await writeFile(path.join(root, "tagged.md"), "---\ntags:\n  - research\nstatus: draft\n---\n\n# Body\n");
    expect(await vault.getFrontmatter("tagged.md")).toEqual({ tags: ["research"], status: "draft" });
  });

  it("returns {} for notes without frontmatter", async () => {
    expect(await vault.getFrontmatter("inbox.md")).toEqual({});
  });
});

describe("createNote", () => {
  it("creates nested folders and normalizes the .md suffix", async () => {
    const rel = await vault.createNote("deep/nested/new note", "# hello\n");
    expect(rel).toBe("deep/nested/new note.md");
    expect(await readFile(path.join(root, rel), "utf8")).toBe("# hello\n");
  });

  it("refuses to overwrite by default (kernel-level wx flag)", async () => {
    await expect(vault.createNote("inbox.md", "clobber")).rejects.toThrow(/already exists/);
    expect(await vault.readNote("inbox.md")).toBe("# Inbox\n");
  });

  it("overwrites when explicitly told", async () => {
    await vault.createNote("scratch.md", "v2", { overwrite: true });
    expect(await vault.readNote("scratch.md")).toBe("v2");
  });

  it("serializes frontmatter objects to YAML", async () => {
    await vault.createNote("fm.md", "# Body\n", { frontmatter: { tags: ["x"], n: 1 } });
    const raw = await readFile(path.join(root, "fm.md"), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(await vault.getFrontmatter("fm.md")).toEqual({ tags: ["x"], n: 1 });
    expect(raw.endsWith("# Body\n")).toBe(true);
  });
});

describe("editNote", () => {
  const target = "edit/me.md";
  beforeAll(async () => {
    await vault.createNote(target, "---\nstatus: draft\n---\n\n# Top\n\n## Sub\n\nold body\n");
  });

  it("appends at the end", async () => {
    await vault.editNote(target, { mode: "append", content: "\n# Footer\n" });
    const raw = await vault.readNote(target);
    expect(raw.trimEnd().endsWith("# Footer")).toBe(true);
  });

  it("prepends AFTER frontmatter, never inside it", async () => {
    await vault.editNote(target, { mode: "prepend", content: "first line" });
    const raw = await vault.readNote(target);
    expect(raw.startsWith("---\nstatus: draft\n---\n")).toBe(true);
    expect(raw).toContain("first line\n\n# Top");
  });

  it("replaces all occurrences and reports the count", async () => {
    await vault.createNote("edit/counts.md", "dup dup dup\n");
    const report = await vault.editNote("edit/counts.md", { mode: "find_replace", find: "dup", replace: "x" });
    expect(report).toMatch(/3 occurrence/);
    expect(await vault.readNote("edit/counts.md")).toBe("x x x\n");
  });

  it("fails clearly when find-text is absent", async () => {
    await expect(
      vault.editNote("edit/counts.md", { mode: "find_replace", find: "nope", replace: "y" }),
    ).rejects.toThrow(/not found/);
  });

  it("replace_section swallows subsections but stops at same-level headings", async () => {
    await vault.createNote(
      "edit/sections.md",
      "# Top\n\n## A\n\nold a\n\n### A1\n\nold a1\n\n## B\n\nkeep b\n",
    );
    await vault.editNote("edit/sections.md", {
      mode: "replace_section",
      heading: "A",
      content: "new a",
    });
    const raw = await vault.readNote("edit/sections.md");
    expect(raw).toContain("## A\n\nnew a\n\n## B");
    expect(raw).not.toContain("old a1");
    expect(raw).toContain("keep b");
  });

  it("replace_section names the existing headings on a miss", async () => {
    await expect(
      vault.editNote("edit/sections.md", { mode: "replace_section", heading: "Zzz", content: "x" }),
    ).rejects.toThrow(/# Top, ## A, ## B/);
  });
});

describe("deleteNote", () => {
  it("normalizes and trashes", async () => {
    await vault.createNote("edit/temp", "bye\n");
    const where = await vault.deleteNote("edit/temp"); // no .md — still works
    expect(where).toBe(".trash/temp.md");
    await expect(vault.readNote("edit/temp.md")).rejects.toThrow(/ENOENT/);
  });
});

describe("links: getBacklinks + moveNote", () => {
  beforeAll(async () => {
    await mkdir(path.join(root, "amb1"), { recursive: true });
    await mkdir(path.join(root, "amb2"), { recursive: true });
    await writeFile(path.join(root, "b.md"), "# B\n");
    await writeFile(path.join(root, "a.md"), "see [[b]] here\n");
    await writeFile(path.join(root, "c.md"), "[[b|the alias]]\n[[b#x]]\n");
    await writeFile(path.join(root, "d.md"), "![[b]] embed\n");
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "m.md"), "[text](../b.md)\n");
    // ambiguity: two notes named `dup` — bare links must NOT resolve
    await writeFile(path.join(root, "amb1", "dup.md"), "# one\n");
    await writeFile(path.join(root, "amb2", "dup.md"), "# two\n");
    await writeFile(path.join(root, "ambtest.md"), "bare [[dup]] ambiguous\npath [[amb1/dup]] exact\n");
  });

  it("finds bare, aliased, heading, embed and markdown-link references", async () => {
    const backlinks = await vault.getBacklinks("b");
    const where = backlinks.map((bl) => `${bl.source}:${bl.line}`).sort();
    expect(where).toEqual(["a.md:1", "c.md:1", "c.md:2", "d.md:1", "notes/m.md:1"]);
  });

  it("treats ambiguous bare links as non-links; path links still resolve", async () => {
    // amb1/dup is referenced once by bare name (skipped — ambiguous) and
    // once by path (counted).
    expect((await vault.getBacklinks("amb1/dup")).map((bl) => bl.line)).toEqual([2]);
    expect(await vault.getBacklinks("amb2/dup")).toEqual([]);
  });

  it("moves a note and repairs every link shape", async () => {
    await writeFile(path.join(root, "inbound-bare.md"), "[[beta]] works\n");
    await writeFile(path.join(root, "inbound-path.md"), "see [[notes/beta|al]] and [[notes/beta#h]]\n");
    await writeFile(path.join(root, "inbound-md.md"), "[t](notes/beta.md)\n");
    await writeFile(path.join(root, "notes", "beta.md"), "# Beta\n\n[rel](gamma.md)\n");
    await writeFile(path.join(root, "notes", "gamma.md"), "# Gamma\n");

    const result = await vault.moveNote("notes/beta", "archive/beta2");
    expect(result.to).toBe("archive/beta2.md");
    expect(result.filesTouched).toBe(4); // 3 inbound files + the moved note itself

    expect(await vault.readNote("inbound-bare.md")).toContain("[[beta2]]");
    expect(await vault.readNote("inbound-path.md")).toContain("[[archive/beta2|al]] and [[archive/beta2#h]]");
    // inbound markdown link now points at the new location
    expect(await vault.readNote("inbound-md.md")).toContain("(archive/beta2.md)");
    // the MOVED note's own relative link was rebased to its new folder
    expect(await vault.readNote("archive/beta2.md")).toContain("[rel](../notes/gamma.md)");
    await expect(vault.readNote("notes/beta.md")).rejects.toThrow(/ENOENT/);
  });

  it("refuses destructive move mistakes", async () => {
    await expect(vault.moveNote("b.md", "b.md")).rejects.toThrow(/same/);
    await expect(vault.moveNote("b.md", "inbox.md")).rejects.toThrow(/already exists/);
    await expect(vault.moveNote("ghost.md", "x.md")).rejects.toThrow(/No such note/);
    await expect(vault.moveNote("../outside.md", "x.md")).rejects.toThrow(VaultPathError);
  });
});

describe("empty-folder pruning", () => {
  it("removes emptied ancestors after delete, stopping at non-empty ones", async () => {
    await vault.createNote("deep/a/b/last.md", "content");
    await vault.createNote("deep/keep.md", "stays");
    await vault.deleteNote("deep/a/b/last.md");

    // b and a emptied by the delete; deep survives (still holds keep.md)
    const exists = async (p: string) =>
      stat(path.join(root, p)).then(() => true).catch(() => false);
    expect(await exists("deep/a/b")).toBe(false);
    expect(await exists("deep/a")).toBe(false);
    expect(await exists("deep")).toBe(true);
    expect(await vault.readNote("deep/keep.md")).toBe("stays");
  });

  it("prunes the whole emptied chain but never the vault root", async () => {
    await vault.createNote("chain/x/y/solo.md", "content");
    await vault.deleteNote("chain/x/y/solo.md");
    const exists = async (p: string) =>
      stat(path.join(root, p)).then(() => true).catch(() => false);
    expect(await exists("chain/x/y")).toBe(false);
    expect(await exists("chain/x")).toBe(false);
    expect(await exists("chain")).toBe(false);
    expect(await exists(".")).toBe(true); // the vault root itself is untouchable
  });

  it("leaves folders that hold dotfiles (.DS_Store survival)", async () => {
    await mkdir(path.join(root, "dotdir"), { recursive: true });
    await writeFile(path.join(root, "dotdir", "n.md"), "x");
    await writeFile(path.join(root, "dotdir", ".DS_Store"), "junk");
    await vault.deleteNote("dotdir/n.md");
    const exists = await stat(path.join(root, "dotdir")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("move_note prunes the emptied source folder", async () => {
    await vault.createNote("olddir/wanderer.md", "content");
    await vault.moveNote("olddir/wanderer.md", "newdir/wanderer.md");
    const exists = await stat(path.join(root, "olddir")).then(() => true).catch(() => false);
    expect(exists).toBe(false);
    expect(await vault.readNote("newdir/wanderer.md")).toBe("content");
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  // sanity: nothing about the fixture leaks
  expect((await readdir(tmpdir())).some((d) => d.includes("obsidian-vault"))).toBe(false);
});
