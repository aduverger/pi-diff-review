import type { DiffReviewComment, ReviewContext, ReviewFile, ReviewSubmitPayload } from "./types.js";

const HEADER = "Please address the following feedback";
const CONTROL_TOKEN_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const JSON_UNESCAPED_CONTROL_PATTERN = /[\u007f-\u009f\u2028\u2029]/g;

export interface ResolvedCommentTarget {
  context: ReviewContext;
  file: ReviewFile;
  repositoryPath: string;
  repositoryLabel: string;
}

export type ResolveCommentTarget = (comment: DiffReviewComment) => ResolvedCommentTarget | null;

interface ResolvedComment {
  comment: DiffReviewComment;
  target: ResolvedCommentTarget;
  locationPath: string;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function joinWorkspacePath(repositoryPath: string, filePath: string): string {
  if (repositoryPath === ".") return filePath;
  return `${repositoryPath}/${filePath}`;
}

function formatPromptToken(value: string): string {
  if (!CONTROL_TOKEN_PATTERN.test(value)) return value;
  return JSON.stringify(value).replace(
    JSON_UNESCAPED_CONTROL_PATTERN,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function getLocationPath(comment: DiffReviewComment, target: ResolvedCommentTarget): string {
  const { file, repositoryPath } = target;
  const repositoryRelativePath = comment.side === "original"
    ? file.oldPath ?? file.newPath
    : file.newPath ?? file.oldPath;

  return repositoryRelativePath == null
    ? file.workspacePath
    : joinWorkspacePath(repositoryPath, repositoryRelativePath);
}

function assertValidTarget(comment: DiffReviewComment, target: ResolvedCommentTarget | null): asserts target is ResolvedCommentTarget {
  if (target == null) {
    throw new Error(`Cannot resolve review comment ${comment.id}.`);
  }

  if (
    target.context.key !== comment.contextKey
    || target.context.mode !== comment.mode
    || target.context.repositoryId !== comment.repositoryId
    || target.file.id !== comment.fileId
    || target.file.repositoryId !== comment.repositoryId
  ) {
    throw new Error(`Resolved target does not match review comment ${comment.id}.`);
  }
}

function compareResolvedComments(left: ResolvedComment, right: ResolvedComment): number {
  const modeOrder = { uncommitted: 0, compare: 1 } as const;
  const sideOrder = { file: 0, original: 1, modified: 2 } as const;

  return modeOrder[left.comment.mode] - modeOrder[right.comment.mode]
    || compareText(left.target.repositoryPath, right.target.repositoryPath)
    || compareText(left.target.file.workspacePath, right.target.file.workspacePath)
    || sideOrder[left.comment.side] - sideOrder[right.comment.side]
    || (left.comment.startLine ?? -1) - (right.comment.startLine ?? -1)
    || (left.comment.endLine ?? left.comment.startLine ?? -1) - (right.comment.endLine ?? right.comment.startLine ?? -1)
    || compareText(left.comment.id, right.comment.id);
}

function formatLocation(resolved: ResolvedComment): string {
  const { comment, locationPath, target } = resolved;
  const formattedPath = formatPromptToken(locationPath);
  if (comment.side === "file" || comment.startLine == null) {
    return formattedPath;
  }

  const lineRange = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;
  const originalSuffix = comment.side === "original"
    ? target.context.mode === "uncommitted" ? " (HEAD)" : " (base)"
    : "";

  return `${formattedPath}:${lineRange}${originalSuffix}`;
}

function getCompareGroupKey(resolved: ResolvedComment): string {
  return resolved.comment.repositoryId;
}

function getCompareGroupLine(resolved: ResolvedComment): string {
  const { context, repositoryPath, repositoryLabel } = resolved.target;
  if (context.baseRef == null || context.headRef == null) {
    throw new Error(`Compare context ${context.key} is missing base or head ref.`);
  }

  const repository = repositoryPath === "." ? repositoryLabel : repositoryPath;
  return `Compare ${formatPromptToken(repository)} ${formatPromptToken(context.baseRef)}...${formatPromptToken(context.headRef)}`;
}

export function composeReviewPrompt(payload: ReviewSubmitPayload, resolveTarget: ResolveCommentTarget): string {
  const resolvedComments = payload.comments.map((comment) => {
    const target = resolveTarget(comment);
    assertValidTarget(comment, target);
    return {
      comment,
      target,
      locationPath: getLocationPath(comment, target),
    };
  }).sort(compareResolvedComments);

  const blocks = [HEADER];
  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) blocks.push(overallComment);

  const compareGroups = new Map<string, string>();
  for (const resolved of resolvedComments) {
    if (resolved.comment.mode !== "compare") continue;
    const key = getCompareGroupKey(resolved);
    const groupLine = getCompareGroupLine(resolved);
    const existing = compareGroups.get(key);
    if (existing != null && existing !== groupLine) {
      throw new Error(`Repository ${resolved.comment.repositoryId} has inconsistent compare contexts.`);
    }
    compareGroups.set(key, groupLine);
  }

  const emittedCompareGroups = new Set<string>();
  for (const resolved of resolvedComments) {
    if (resolved.comment.mode === "compare") {
      const key = getCompareGroupKey(resolved);
      if (!emittedCompareGroups.has(key)) {
        blocks.push(compareGroups.get(key)!);
        emittedCompareGroups.add(key);
      }
    }

    blocks.push(`${formatLocation(resolved)}\n${resolved.comment.body.trim()}`);
  }

  return blocks.join("\n\n");
}
