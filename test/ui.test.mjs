import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildHostMessageScript,
  buildReviewHtml,
  decodeReviewWindowMessage,
  escapeForInlineScript,
} from "../src/ui.ts";

test("escapes inline-script delimiters and JavaScript line separators", () => {
  assert.equal(
    escapeForInlineScript("<&>\u2028\u2029"),
    "\\u003c\\u0026\\u003e\\u2028\\u2029",
  );
});

test("builds a safely escaped host callback", () => {
  const script = buildHostMessageScript({
    type: "file-error",
    requestId: "request-a",
    repositoryId: "repository-a",
    contextKey: "context-a",
    fileId: "file-a",
    message: "</script>&\u2029",
  });

  assert.ok(script.startsWith("window.__reviewReceive({"));
  assert.ok(script.endsWith("});"));
  assert.ok(script.includes('"message":"\\u003c/script\\u003e\\u0026\\u2029"'));
  assert.ok(!script.includes("</script>"));
});

test("decodes compare and submit messages into validated records", () => {
  assert.deepEqual(decodeReviewWindowMessage({ type: "ready" }), { type: "ready" });
  assert.deepEqual(
    decodeReviewWindowMessage({
      type: "request-compare",
      requestId: "request-a",
      repositoryId: "repository-a",
      baseRef: "main",
      headRef: "HEAD~1",
      ignored: true,
    }),
    {
      type: "request-compare",
      requestId: "request-a",
      repositoryId: "repository-a",
      baseRef: "main",
      headRef: "HEAD~1",
    },
  );

  const submission = decodeReviewWindowMessage({
    type: "submit",
    overallComment: "Overall",
    comments: [{
      id: "comment-a",
      repositoryId: "repository-a",
      contextKey: "context-a",
      fileId: "file-a",
      mode: "compare",
      side: "modified",
      startLine: 4,
      endLine: 8,
      body: "Fix this.",
    }],
  });
  assert.equal(submission.type, "submit");
  assert.equal(submission.comments[0].endLine, 8);
});

test("rejects malformed protocol records, Git revisions, and comment ranges", () => {
  assert.throws(() => decodeReviewWindowMessage(null), /must be an object/);
  assert.throws(
    () => decodeReviewWindowMessage({
      type: "request-compare",
      requestId: "request-a",
      repositoryId: "repository-a",
      baseRef: "--help",
      headRef: "HEAD",
    }),
    /valid Git revision/,
  );
  assert.throws(
    () => decodeReviewWindowMessage({
      type: "submit",
      overallComment: "",
      comments: [{
        id: "comment-a",
        repositoryId: "repository-a",
        contextKey: "context-a",
        fileId: "file-a",
        mode: "uncommitted",
        side: "original",
        startLine: 9,
        endLine: 3,
        body: "Fix this.",
      }],
    }),
    /ordered line range/,
  );
});

test("inlines fresh assets with only the trusted bootstrap field", () => {
  const workspaceRoot = "</script>&\u2028$&";
  const html = buildReviewHtml({ workspaceRoot, ignored: "not-bootstrap-data" });
  const reviewStateJs = readFileSync(new URL("../web/review-state.js", import.meta.url), "utf8");
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

  assert.match(html, /<script id="diff-review-data" type="application\/json">/);
  assert.ok(html.includes(reviewStateJs));
  assert.ok(html.includes(appJs));
  assert.ok(html.includes('"workspaceRoot":"\\u003c/script\\u003e\\u0026\\u2028$\\u0026"'));
  assert.ok(!html.includes("not-bootstrap-data"));
  assert.ok(!html.includes("__INLINE_DATA__"));
  assert.ok(!html.includes("__INLINE_JS__"));
});

test("does not rescan bootstrap data for asset markers", () => {
  const workspaceRoot = "/workspace/__INLINE_JS__/__INLINE_DATA__";
  const html = buildReviewHtml({ workspaceRoot });
  const payload = html.match(
    /<script id="diff-review-data" type="application\/json">([\s\S]*?)<\/script>/,
  );

  assert.ok(payload);
  assert.deepEqual(JSON.parse(payload[1]), { workspaceRoot });
});
