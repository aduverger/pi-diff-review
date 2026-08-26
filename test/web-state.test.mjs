import assert from "node:assert/strict";
import test from "node:test";

await import("../web/review-state.js");

const {
  acceptComparison,
  beginComparison,
  buildFileTree,
  contextIndexKey,
  createCompareState,
  receiveComparison,
  rejectComparison,
  restoreComparisonInputs,
  settleFileLoad,
  viewKey,
} = globalThis.__piDiffReviewState;

test("keys preserve repository, context, and file boundaries", () => {
  assert.notEqual(contextIndexKey("a", "b:c"), contextIndexKey("a:b", "c"));
  assert.deepEqual(JSON.parse(contextIndexKey("repo", "context")), ["repo", "context"]);
  assert.notEqual(viewKey("a", "b:c", "d"), viewKey("a:b", "c", "d"));
  assert.notEqual(viewKey("a", "b", "c:d"), viewKey("a", "b:c", "d"));
  assert.deepEqual(JSON.parse(viewKey("repo", "context", "file")), ["repo", "context", "file"]);
});

test("file trees preserve a path that is both a file and a directory", () => {
  const directFile = { id: "direct", newPath: "foo" };
  const childFile = { id: "child", newPath: "foo/bar.ts" };
  const tree = buildFileTree([childFile, directFile]);
  const foo = tree.children.get("foo");

  assert.equal(foo.file, directFile);
  assert.equal(foo.children.get("bar.ts").file, childFile);
});

test("file load transitions reject stale and mismatched responses", () => {
  const load = {
    status: "loading",
    requestId: "request-2",
    repositoryId: "repository-a",
    contextKey: "context-a",
    fileId: "file-a",
    mode: "uncommitted",
  };
  const contents = {
    original: { kind: "text", text: "before" },
    modified: { kind: "text", text: "after" },
  };

  assert.equal(settleFileLoad(load, { ...load, requestId: "request-1", contents }, "ready"), null);
  assert.equal(settleFileLoad(load, { ...load, repositoryId: "repository-b", contents }, "ready"), null);

  const ready = settleFileLoad(load, { ...load, contents }, "ready");
  assert.deepEqual(ready, { ...load, status: "ready", requestId: null, contents });
  assert.equal(settleFileLoad(ready, { ...load, contents }, "ready"), null);
});

test("compare state keeps only the latest request and accepted refs", () => {
  const initial = createCompareState({ id: "repository-a", baseRef: "origin/main", headRef: "HEAD" });
  const first = beginComparison(initial, "request-1", "origin/main", "HEAD");
  const latest = beginComparison(first, "request-2", "release", "feature");

  assert.equal(receiveComparison(latest, { repositoryId: "repository-a", requestId: "request-1" }), null);
  assert.equal(receiveComparison(latest, { repositoryId: "repository-b", requestId: "request-2" }), null);

  const received = receiveComparison(latest, { repositoryId: "repository-a", requestId: "request-2" });
  assert.equal(received.loading, false);
  assert.equal(rejectComparison(latest, {
    repositoryId: "repository-a",
    requestId: "request-2",
    message: "invalid ref",
  }).error, "invalid ref");

  const comparison = {
    repositoryId: "repository-a",
    baseRef: "release",
    headRef: "feature",
    changeSet: { context: { key: "compare-key" }, files: [] },
  };
  const accepted = acceptComparison(received, comparison);
  assert.equal(accepted.comparison, comparison);
  assert.equal(accepted.acceptedBaseRef, "release");
  assert.equal(accepted.acceptedHeadRef, "feature");
  assert.equal(accepted.error, null);

  const restored = restoreComparisonInputs({ ...accepted, baseInput: "bad", headInput: "worse" }, comparison);
  assert.equal(restored.baseInput, "release");
  assert.equal(restored.headInput, "feature");
});
