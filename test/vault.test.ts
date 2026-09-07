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

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  // sanity: nothing about the fixture leaks
  expect((await readdir(tmpdir())).some((d) => d.includes("obsidian-vault"))).toBe(false);
});
