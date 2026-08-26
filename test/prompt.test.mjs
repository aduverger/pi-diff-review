import assert from "node:assert/strict";
import test from "node:test";
import { composeReviewPrompt } from "../src/prompt.ts";

const HEADER = "Please address the following feedback";

function context(overrides = {}) {
  return {
    key: "uncommitted:root",
    mode: "uncommitted",
    repositoryId: "root",
    ...overrides,
  };
}

function file(overrides = {}) {
  return {
    id: "file-a",
    repositoryId: "root",
    workspacePath: "src/a.ts",
    status: "modified",
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    displayPath: "src/a.ts",
    oldMode: null,
    newMode: null,
    oldOid: null,
    newOid: null,
    submoduleState: null,
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    id: "comment-a",
    repositoryId: "root",
    contextKey: "uncommitted:root",
    fileId: "file-a",
    mode: "uncommitted",
    side: "modified",
    startLine: 4,
    endLine: 4,
    body: "Change this.",
    ...overrides,
  };
}

function payload(comments = [], overallComment = "") {
  return { type: "submit", overallComment, comments };
}

function resolver(targets) {
  return (reviewComment) => targets.get(reviewComment.id) ?? null;
}

function target(overrides = {}) {
  return {
    context: context(),
    file: file(),
    repositoryPath: ".",
    repositoryLabel: "app",
    ...overrides,
  };
}

test("returns only the header for zero comments", () => {
  assert.equal(composeReviewPrompt(payload(), () => null), HEADER);
});

test("trims and preserves an overall comment without indentation", () => {
  assert.equal(
    composeReviewPrompt(payload([], "  First line\nsecond line  "), () => null),
    `${HEADER}\n\nFirst line\nsecond line`,
  );
});

test("formats a file comment with only its trusted workspace path", () => {
  const reviewComment = comment({ side: "file", startLine: null, endLine: null });
  const targets = new Map([[reviewComment.id, target()]]);

  assert.equal(
    composeReviewPrompt(payload([reviewComment]), resolver(targets)),
    `${HEADER}\n\nsrc/a.ts\nChange this.`,
  );
});

test("formats original and modified line or range comments", () => {
  const original = comment({ id: "original", side: "original", startLine: 3, endLine: 3, body: "Old line." });
  const modified = comment({ id: "modified", side: "modified", startLine: 8, endLine: 10, body: "New range." });
  const targets = new Map([
    [original.id, target()],
    [modified.id, target()],
  ]);

  assert.equal(
    composeReviewPrompt(payload([modified, original]), resolver(targets)),
    `${HEADER}\n\nsrc/a.ts:3 (HEAD)\nOld line.\n\nsrc/a.ts:8-10\nNew range.`,
  );
});

test("uses side-specific paths for renamed and deleted files", () => {
  const renamedOriginal = comment({ id: "rename-old", fileId: "renamed", side: "original", body: "Old name." });
  const renamedCurrent = comment({ id: "rename-new", fileId: "renamed", side: "modified", body: "New name." });
  const deletedFile = comment({ id: "deleted-file", fileId: "deleted", side: "file", startLine: null, endLine: null, body: "Deleted file." });
  const targets = new Map([
    [renamedOriginal.id, target({ file: file({ id: "renamed", workspacePath: "pkg/new.ts", oldPath: "old.ts", newPath: "new.ts", status: "renamed" }), repositoryPath: "pkg" })],
    [renamedCurrent.id, target({ file: file({ id: "renamed", workspacePath: "pkg/new.ts", oldPath: "old.ts", newPath: "new.ts", status: "renamed" }), repositoryPath: "pkg" })],
    [deletedFile.id, target({ file: file({ id: "deleted", workspacePath: "pkg/gone.ts", oldPath: "gone.ts", newPath: null, status: "deleted" }), repositoryPath: "pkg" })],
  ]);

  assert.equal(
    composeReviewPrompt(payload([renamedCurrent, deletedFile, renamedOriginal]), resolver(targets)),
    `${HEADER}\n\npkg/gone.ts\nDeleted file.\n\npkg/old.ts:4 (HEAD)\nOld name.\n\npkg/new.ts:4\nNew name.`,
  );
});

test("preserves multiline comment bodies verbatim except outer whitespace", () => {
  const reviewComment = comment({ body: "\n  Keep this indentation.\n\nSecond paragraph.\n" });
  const targets = new Map([[reviewComment.id, target()]]);

  assert.equal(
    composeReviewPrompt(payload([reviewComment]), resolver(targets)),
    `${HEADER}\n\nsrc/a.ts:4\nKeep this indentation.\n\nSecond paragraph.`,
  );
});

test("JSON-quotes control-bearing file and repository paths", () => {
  const reviewComment = comment({ id: "controls", fileId: "controls", startLine: 12, endLine: 13 });
  const unsafePath = "src/line\nbreak\t\u2028.ts";
  const targets = new Map([[reviewComment.id, target({
    file: file({
      id: "controls",
      workspacePath: `packages/\u007f/${unsafePath}`,
      oldPath: unsafePath,
      newPath: unsafePath,
    }),
    repositoryPath: "packages/\u007f",
  })]]);

  assert.equal(
    composeReviewPrompt(payload([reviewComment]), resolver(targets)),
    `${HEADER}\n\n"packages/\\u007f/src/line\\nbreak\\t\\u2028.ts":12-13\nChange this.`,
  );
});

test("JSON-quotes control-bearing compare repository and ref tokens", () => {
  const reviewComment = comment({
    id: "compare-controls",
    contextKey: "compare:root",
    mode: "compare",
  });
  const compareContext = context({
    key: "compare:root",
    mode: "compare",
    baseRef: "main\tbase",
    headRef: "head\u009f",
  });
  const targets = new Map([[reviewComment.id, target({
    context: compareContext,
    repositoryLabel: "repo\nlabel",
  })]]);

  assert.equal(
    composeReviewPrompt(payload([reviewComment]), resolver(targets)),
    `${HEADER}\n\nCompare "repo\\nlabel" "main\\tbase"..."head\\u009f"\n\nsrc/a.ts:4\nChange this.`,
  );
});

test("groups compare comments once per repository after uncommitted comments", () => {
  const worktree = comment({ id: "worktree", body: "Worktree first." });
  const rootCompareOriginal = comment({
    id: "root-old",
    contextKey: "compare:root",
    mode: "compare",
    side: "original",
    startLine: 2,
    endLine: 2,
    body: "Root base.",
  });
  const rootCompareCurrent = comment({
    id: "root-new",
    contextKey: "compare:root",
    mode: "compare",
    side: "modified",
    startLine: 5,
    endLine: 5,
    body: "Root head.",
  });
  const nestedCompare = comment({
    id: "nested",
    repositoryId: "lib",
    contextKey: "compare:lib",
    fileId: "lib-file",
    mode: "compare",
    startLine: 7,
    endLine: 7,
    body: "Nested head.",
  });
  const rootCompareContext = context({ key: "compare:root", mode: "compare", baseRef: "main", headRef: "feature" });
  const nestedCompareContext = context({ key: "compare:lib", mode: "compare", repositoryId: "lib", baseRef: "v1", headRef: "v2" });
  const targets = new Map([
    [worktree.id, target()],
    [rootCompareOriginal.id, target({ context: rootCompareContext })],
    [rootCompareCurrent.id, target({ context: rootCompareContext })],
    [nestedCompare.id, target({
      context: nestedCompareContext,
      file: file({ id: "lib-file", repositoryId: "lib", workspacePath: "packages/lib/src/lib.ts", oldPath: "src/lib.ts", newPath: "src/lib.ts" }),
      repositoryPath: "packages/lib",
      repositoryLabel: "lib",
    })],
  ]);

  assert.equal(
    composeReviewPrompt(payload([nestedCompare, rootCompareCurrent, worktree, rootCompareOriginal]), resolver(targets)),
    `${HEADER}\n\nsrc/a.ts:4\nWorktree first.\n\nCompare app main...feature\n\nsrc/a.ts:2 (base)\nRoot base.\n\nsrc/a.ts:5\nRoot head.\n\nCompare packages/lib v1...v2\n\npackages/lib/src/lib.ts:7\nNested head.`,
  );
});

test("sorts deterministically through the stable comment id tie-breaker", () => {
  const commentB = comment({ id: "b", body: "Second." });
  const commentA = comment({ id: "a", body: "First." });
  const targets = new Map([
    [commentA.id, target()],
    [commentB.id, target()],
  ]);

  const expected = `${HEADER}\n\nsrc/a.ts:4\nFirst.\n\nsrc/a.ts:4\nSecond.`;
  assert.equal(composeReviewPrompt(payload([commentB, commentA]), resolver(targets)), expected);
  assert.equal(composeReviewPrompt(payload([commentA, commentB]), resolver(targets)), expected);
});

test("throws when a trusted target cannot be resolved", () => {
  const reviewComment = comment({ id: "missing" });
  assert.throws(
    () => composeReviewPrompt(payload([reviewComment]), () => null),
    /Cannot resolve review comment missing/,
  );
});
