import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DiffReviewComment,
  ReviewCancelPayload,
  ReviewClientErrorPayload,
  ReviewHostMessage,
  ReviewReadyPayload,
  ReviewRequestComparePayload,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");

export function escapeForInlineScript(value: string): string {
  return value
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = record[field];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function readGitRef(record: Record<string, unknown>, field: string): string {
  const value = readString(record, field);
  if (value.trim() !== value || value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} is not a valid Git revision.`);
  }
  return value;
}

function readNullableLine(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be null or a positive integer.`);
  }
  return value;
}

function decodeComment(value: unknown): DiffReviewComment {
  const comment = asRecord(value, "comment");
  const mode = comment.mode;
  const side = comment.side;
  if (mode !== "uncommitted" && mode !== "compare") {
    throw new Error("comment mode must be uncommitted or compare.");
  }
  if (side !== "original" && side !== "modified" && side !== "file") {
    throw new Error("comment side must be original, modified, or file.");
  }

  const startLine = readNullableLine(comment, "startLine");
  const endLine = readNullableLine(comment, "endLine");
  if (side === "file") {
    if (startLine != null || endLine != null) {
      throw new Error("File comments cannot include a line range.");
    }
  } else if (startLine == null || endLine == null || startLine > endLine) {
    throw new Error("Line comments require an ordered line range.");
  }

  return {
    id: readString(comment, "id"),
    repositoryId: readString(comment, "repositoryId"),
    contextKey: readString(comment, "contextKey"),
    fileId: readString(comment, "fileId"),
    mode,
    side,
    startLine,
    endLine,
    body: readString(comment, "body", true),
  };
}

export function decodeReviewWindowMessage(value: unknown): ReviewWindowMessage {
  const message = asRecord(value, "Review message");
  const type = readString(message, "type");

  if (type === "request-file") {
    return {
      type,
      requestId: readString(message, "requestId"),
      repositoryId: readString(message, "repositoryId"),
      contextKey: readString(message, "contextKey"),
      fileId: readString(message, "fileId"),
    } satisfies ReviewRequestFilePayload;
  }

  if (type === "request-compare") {
    return {
      type,
      requestId: readString(message, "requestId"),
      repositoryId: readString(message, "repositoryId"),
      baseRef: readGitRef(message, "baseRef"),
      headRef: readGitRef(message, "headRef"),
    } satisfies ReviewRequestComparePayload;
  }

  if (type === "submit") {
    if (!Array.isArray(message.comments)) {
      throw new Error("comments must be an array.");
    }
    const comments = message.comments.map(decodeComment);
    const commentIds = new Set<string>();
    for (const comment of comments) {
      if (commentIds.has(comment.id)) {
        throw new Error(`Duplicate comment id: ${comment.id}`);
      }
      commentIds.add(comment.id);
    }
    return {
      type,
      overallComment: readString(message, "overallComment", true),
      comments,
    } satisfies ReviewSubmitPayload;
  }

  if (type === "cancel") {
    return { type } satisfies ReviewCancelPayload;
  }

  if (type === "ready") {
    return { type } satisfies ReviewReadyPayload;
  }

  if (type === "client-error") {
    return {
      type,
      message: readString(message, "message"),
    } satisfies ReviewClientErrorPayload;
  }

  throw new Error(`Unknown review message type: ${type}`);
}

export function buildHostMessageScript(message: ReviewHostMessage): string {
  return `window.__reviewReceive(${escapeForInlineScript(JSON.stringify(message))});`;
}

export function buildReviewHtml(data: { workspaceRoot: string }): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const reviewStateJs = readFileSync(join(webDir, "review-state.js"), "utf8");
  const appJs = readFileSync(join(webDir, "app.js"), "utf8");
  const payload = escapeForInlineScript(JSON.stringify({ workspaceRoot: data.workspaceRoot }));
  return templateHtml.replace(
    /__INLINE_DATA__|__INLINE_JS__/g,
    (marker) => marker === "__INLINE_DATA__" ? payload : `${reviewStateJs}\n${appJs}`,
  );
}
