export type ReviewMode = "uncommitted" | "compare";

export type ChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "conflicted";

export interface DiscoveredRepository {
  id: string;
  root: string;
  workspacePath: string;
  name: string;
}

export interface ReviewContext {
  key: string;
  mode: ReviewMode;
  repositoryId: string;
  baseRef?: string;
  headRef?: string;
  baseOid?: string;
  headOid?: string;
  mergeBaseOid?: string;
}

export interface ReviewFile {
  id: string;
  repositoryId: string;
  workspacePath: string;
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  submoduleState: string | null;
}

export interface ReviewChangeSet {
  context: ReviewContext;
  files: ReviewFile[];
}

export interface ReviewRepositoryData {
  id: string;
  name: string;
  workspacePath: string;
  baseRef: string | null;
  headRef: "HEAD";
  headOid: string | null;
  uncommitted: ReviewChangeSet | null;
  error?: string;
}

export interface ReviewComparisonData {
  repositoryId: string;
  baseRef: string;
  headRef: string;
  baseOid: string;
  headOid: string;
  mergeBaseOid: string;
  changeSet: ReviewChangeSet;
}

export type ReviewContent =
  | { kind: "text"; text: string }
  | { kind: "binary"; byteLength?: number }
  | { kind: "symlink"; text: string }
  | { kind: "gitlink"; text: string }
  | { kind: "special"; message: string }
  | { kind: "missing" };

export interface ReviewFileContents {
  original: ReviewContent;
  modified: ReviewContent;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  repositoryId: string;
  contextKey: string;
  fileId: string;
  mode: ReviewMode;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewReadyPayload {
  type: "ready";
}

export interface ReviewRequestComparePayload {
  type: "request-compare";
  requestId: string;
  repositoryId: string;
  baseRef: string;
  headRef: string;
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  repositoryId: string;
  contextKey: string;
  fileId: string;
}

export type ReviewWindowMessage =
  | ReviewReadyPayload
  | ReviewSubmitPayload
  | ReviewCancelPayload
  | ReviewRequestComparePayload
  | ReviewRequestFilePayload;

export interface ReviewWorkspaceDataMessage {
  type: "workspace-data";
  workspaceRoot: string;
  warnings: string[];
  repositories: ReviewRepositoryData[];
}

export interface ReviewCompareDataMessage {
  type: "compare-data";
  requestId: string;
  repositoryId: string;
  comparison: ReviewComparisonData;
}

export interface ReviewCompareErrorMessage {
  type: "compare-error";
  requestId: string;
  repositoryId: string;
  baseRef: string;
  headRef: string;
  message: string;
}

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  repositoryId: string;
  contextKey: string;
  fileId: string;
  contents: ReviewFileContents;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  repositoryId: string;
  contextKey: string;
  fileId: string;
  message: string;
}

export type ReviewHostMessage =
  | ReviewWorkspaceDataMessage
  | ReviewCompareDataMessage
  | ReviewCompareErrorMessage
  | ReviewFileDataMessage
  | ReviewFileErrorMessage;
