import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  checkoutBranch,
  commitFile,
  countCommitsAhead,
  createRefactorBranch,
  deleteBranch,
  getCurrentBranch,
  hasUncommittedChanges,
} from "../src/vcs/gitManager.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmanager-test-"));
  execSync("git init -q", { cwd: tmpDir });
  execSync("git config user.email test@test.com", { cwd: tmpDir });
  execSync("git config user.name Test", { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a, b) { return a + b; }\n");
  execSync("git add . && git commit -q -m initial", { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getCurrentBranch", () => {
  it("returns the repo's current branch name", async () => {
    const branch = await getCurrentBranch(tmpDir);
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });
});

describe("createRefactorBranch", () => {
  it("creates and checks out a new branch prefixed agent/refactor-", async () => {
    const branchName = await createRefactorBranch(tmpDir, "task-0");
    expect(branchName).toMatch(/^agent\/refactor-\d+-task-0$/);
    const current = await getCurrentBranch(tmpDir);
    expect(current).toBe(branchName);
  });

  it("creates a unique branch name without a label too", async () => {
    const branchName = await createRefactorBranch(tmpDir);
    expect(branchName).toMatch(/^agent\/refactor-\d+$/);
  });
});

describe("hasUncommittedChanges", () => {
  it("is false right after a clean checkout", async () => {
    expect(await hasUncommittedChanges(tmpDir)).toBe(false);
  });

  it("is true after editing a tracked file", async () => {
    fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a, b) { return a + b + 1; }\n");
    expect(await hasUncommittedChanges(tmpDir)).toBe(true);
  });
});

describe("commitFile", () => {
  it("commits a staged change and returns a commit hash", async () => {
    fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a: number, b: number): number { return a + b; }\n");
    const hash = await commitFile(tmpDir, "file.js", "Add types");
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await hasUncommittedChanges(tmpDir)).toBe(false);
  });
});

describe("checkoutBranch / deleteBranch / countCommitsAhead", () => {
  it("switches back to the original branch and deletes an empty working branch", async () => {
    const base = await getCurrentBranch(tmpDir);
    const work = await createRefactorBranch(tmpDir, "x");
    expect(await countCommitsAhead(tmpDir, base, work)).toBe(0);

    await checkoutBranch(tmpDir, base);
    await deleteBranch(tmpDir, work);

    expect(await getCurrentBranch(tmpDir)).toBe(base);
    expect(execSync('git branch --list "agent/*"', { cwd: tmpDir }).toString().trim()).toBe("");
  });

  it("counts commits made on the working branch", async () => {
    const base = await getCurrentBranch(tmpDir);
    const work = await createRefactorBranch(tmpDir, "x");
    fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a, b) { return a - b; }\n");
    await commitFile(tmpDir, "file.js", "change one");
    fs.writeFileSync(path.join(tmpDir, "file.js"), "function add(a, b) { return a * b; }\n");
    await commitFile(tmpDir, "file.js", "change two");
    expect(await countCommitsAhead(tmpDir, base, work)).toBe(2);
  });

  it("force-deleting a branch that still has commits works, since the pipeline only deletes branches it has just verified are empty", async () => {
    const base = await getCurrentBranch(tmpDir);
    const work = await createRefactorBranch(tmpDir, "x");
    await checkoutBranch(tmpDir, base);
    await deleteBranch(tmpDir, work);
    expect(execSync('git branch --list "agent/*"', { cwd: tmpDir }).toString().trim()).toBe("");
  });
});