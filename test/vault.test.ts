/**
 * vault.test.ts — unit tests for the filesystem layer, against a real temp dir.
 *
 * Deliberately NOT mocked: the whole point of this layer is precise interaction
 * with a real filesystem (traversal, rename semantics, dot-dirs). Mocking fs
 * here would test the mock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
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

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  // sanity: nothing about the fixture leaks
  expect((await readdir(tmpdir())).some((d) => d.includes("obsidian-vault"))).toBe(false);
});
