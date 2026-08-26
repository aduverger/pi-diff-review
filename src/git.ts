import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import type {
  ChangeStatus,
  DiscoveredRepository,
  ReviewComparisonData,
  ReviewContent,
  ReviewContext,
  ReviewFile,
  ReviewFileContents,
  ReviewRepositoryData,
} from "./types.js";

const PRUNED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "cache",
]);

const ZERO_OID_PATTERN = /^0+$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export interface ParsedGitChange {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  submoduleState: string | null;
  source: "tracked" | "untracked";
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], code: number | null, stderr: string) {
    const detail = stderr.trim() || (code == null ? "could not start" : `exited with code ${code}`);
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitCommandError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

function createAbortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function decodeUtf8(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function decodeForError(buffer: Buffer): string {
  return new TextDecoder("utf-8").decode(buffer);
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  throwIfAborted(signal);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };

    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (error) => rejectOnce(new GitCommandError(args, null, error.message)));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (aborted) {
        rejectPromise(createAbortError());
        return;
      }

      const result = {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code: code ?? 1,
      };
      if (!acceptedExitCodes.includes(result.code)) {
        rejectPromise(new GitCommandError(args, code, decodeForError(result.stderr)));
        return;
      }
      resolvePromise(result);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function runGit(
  repoRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return runCommand("git", args, repoRoot, signal, acceptedExitCodes);
}

function stableHash(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest("hex");
}

function toPosixPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function repositoryId(root: string): string {
  return stableHash(["repository", root]).slice(0, 24);
}

function createRepository(root: string, workspaceRoot: string): DiscoveredRepository {
  const workspaceRelative = toPosixPath(relative(workspaceRoot, root));
  return {
    id: repositoryId(root),
    root,
    workspacePath: workspaceRelative.length === 0 ? "." : workspaceRelative,
    name: basename(root) || root,
  };
}

async function gitMarkerKind(directory: string): Promise<"repository" | "none" | "warning"> {
  try {
    const marker = await lstat(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile() ? "repository" : "none";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "none";
    return "warning";
  }
}

async function findContainingRepository(
  startDirectory: string,
  warnings: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  let current = startDirectory;

  while (true) {
    throwIfAborted(signal);
    const markerKind = await gitMarkerKind(current);
    if (markerKind === "repository") return current;
    if (markerKind === "warning") warnings.push(`Could not inspect ${join(current, ".git")}.`);

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function shouldPruneDirectory(name: string): boolean {
  return name.startsWith(".") || PRUNED_DIRECTORY_NAMES.has(name.toLowerCase());
}

async function discoverNestedRepositories(
  directory: string,
  repositories: string[],
  warnings: string[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not read ${directory}: ${detail}`);
    return;
  }

  const marker = entries.find((entry) => entry.name === ".git");
  if (marker?.isDirectory() || marker?.isFile()) {
    try {
      repositories.push(await realpath(directory));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not resolve repository ${directory}: ${detail}`);
    }
    return;
  }

  const childDirectories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !shouldPruneDirectory(entry.name))
    .sort((a, b) => compareStrings(a.name, b.name));

  for (const entry of childDirectories) {
    await discoverNestedRepositories(join(directory, entry.name), repositories, warnings, signal);
  }
}

export async function discoverRepositories(
  startPath: string,
  signal?: AbortSignal,
): Promise<{ workspaceRoot: string; repositories: DiscoveredRepository[]; warnings: string[] }> {
  throwIfAborted(signal);
  const absoluteStart = resolve(startPath);
  const startStats = await stat(absoluteStart);
  const startDirectory = await realpath(startStats.isDirectory() ? absoluteStart : dirname(absoluteStart));
  const warnings: string[] = [];
  const containingRepository = await findContainingRepository(startDirectory, warnings, signal);

  if (containingRepository != null) {
    const root = await realpath(containingRepository);
    return {
      workspaceRoot: root,
      repositories: [createRepository(root, root)],
      warnings,
    };
  }

  const repositoryRoots: string[] = [];
  await discoverNestedRepositories(startDirectory, repositoryRoots, warnings, signal);
  const uniqueRoots = [...new Set(repositoryRoots)].sort(compareStrings);
  return {
    workspaceRoot: startDirectory,
    repositories: uniqueRoots.map((root) => createRepository(root, startDirectory)),
    warnings,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function splitNulBuffers(output: Buffer, label: string): Buffer[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error(`${label} is missing its final NUL terminator.`);

  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(output.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function splitFixedFields(
  record: Buffer,
  fieldCount: number,
  label: string,
): { fields: string[]; path: string } {
  const fields: string[] = [];
  let start = 0;

  for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
    const separator = record.indexOf(0x20, start);
    if (separator < 0) throw new Error(`Malformed ${label} record.`);
    fields.push(decodeUtf8(record.subarray(start, separator), `${label} field`));
    start = separator + 1;
  }

  return {
    fields,
    path: decodeUtf8(record.subarray(start), `${label} path`),
  };
}

function normalizeMode(mode: string): string | null {
  return ZERO_OID_PATTERN.test(mode) ? null : mode;
}

function normalizeOid(oid: string): string | null {
  return ZERO_OID_PATTERN.test(oid) ? null : oid;
}

function modeType(mode: string | null): string | null {
  return mode == null ? null : mode.slice(0, 3);
}

function normalizeSubmoduleState(value: string): string | null {
  if (value === "N...") return null;
  if (!/^S[.C][.M][.U]$/.test(value)) {
    throw new Error(`Malformed porcelain submodule state ${JSON.stringify(value)}.`);
  }
  return value;
}

function statusForOrdinaryChange(
  xy: string,
  oldMode: string | null,
  newMode: string | null,
): ChangeStatus {
  if (xy.includes("U")) return "conflicted";
  if (oldMode == null && newMode != null) return "added";
  if (oldMode != null && newMode == null) return "deleted";
  if (xy.includes("T")) return "type-changed";
  if (oldMode != null && newMode != null && modeType(oldMode) !== modeType(newMode)) return "type-changed";
  return "modified";
}

function parseOrdinaryStatusRecord(record: Buffer): ParsedGitChange | null {
  const { fields, path } = splitFixedFields(record, 8, "porcelain ordinary");
  const [recordType, xy, submoduleRaw, headModeRaw, _indexModeRaw, worktreeModeRaw, headOidRaw, indexOidRaw] = fields;
  if (recordType !== "1" || xy == null || submoduleRaw == null || headModeRaw == null || worktreeModeRaw == null || headOidRaw == null || indexOidRaw == null) {
    throw new Error("Malformed porcelain ordinary record.");
  }

  const oldMode = normalizeMode(headModeRaw);
  const worktreeMode = normalizeMode(worktreeModeRaw);
  if (oldMode == null && worktreeMode == null) return null;
  const newMode = worktreeMode;
  const oldOid = normalizeOid(headOidRaw);
  const indexOid = normalizeOid(indexOidRaw);
  const workingTreeStatus = xy[1];

  return {
    status: statusForOrdinaryChange(xy, oldMode, newMode),
    oldPath: oldMode == null ? null : path,
    newPath: newMode == null ? null : path,
    oldMode,
    newMode,
    oldOid,
    newOid: newMode != null && workingTreeStatus === "." ? indexOid : null,
    submoduleState: normalizeSubmoduleState(submoduleRaw),
    source: "tracked",
  };
}

function parseRenameStatusRecord(record: Buffer, originalPathRecord: Buffer): ParsedGitChange | null {
  const { fields, path: newPathFromRecord } = splitFixedFields(record, 9, "porcelain rename");
  const [recordType, xy, submoduleRaw, headModeRaw, _indexModeRaw, worktreeModeRaw, headOidRaw, indexOidRaw, score] = fields;
  if (recordType !== "2" || xy == null || submoduleRaw == null || headModeRaw == null || worktreeModeRaw == null || headOidRaw == null || indexOidRaw == null || score == null) {
    throw new Error("Malformed porcelain rename record.");
  }

  const oldPath = decodeUtf8(originalPathRecord, "porcelain original path");
  const oldMode = normalizeMode(headModeRaw);
  const worktreeMode = normalizeMode(worktreeModeRaw);
  if (oldMode == null && worktreeMode == null) return null;
  const newMode = worktreeMode;
  const oldOid = normalizeOid(headOidRaw);
  const indexOid = normalizeOid(indexOidRaw);
  const workingTreeStatus = xy[1];
  const status = score.startsWith("C")
    ? "copied"
    : newMode == null
      ? "deleted"
      : oldMode != null && modeType(oldMode) !== modeType(newMode)
        ? "type-changed"
        : "renamed";

  return {
    status,
    oldPath: oldMode == null ? null : oldPath,
    newPath: newMode == null ? null : newPathFromRecord,
    oldMode,
    newMode,
    oldOid,
    newOid: newMode != null && workingTreeStatus === "." ? indexOid : null,
    submoduleState: normalizeSubmoduleState(submoduleRaw),
    source: "tracked",
  };
}

function parseUnmergedStatusRecord(record: Buffer): ParsedGitChange {
  const { fields, path } = splitFixedFields(record, 10, "porcelain unmerged");
  const [recordType, _xy, submoduleRaw, _baseModeRaw, oursModeRaw, _theirsModeRaw, worktreeModeRaw, _baseOidRaw, oursOidRaw] = fields;
  if (recordType !== "u" || submoduleRaw == null || oursModeRaw == null || worktreeModeRaw == null || oursOidRaw == null) {
    throw new Error("Malformed porcelain unmerged record.");
  }

  const oldMode = normalizeMode(oursModeRaw);
  const worktreeMode = normalizeMode(worktreeModeRaw);
  return {
    status: "conflicted",
    oldPath: oldMode == null ? null : path,
    newPath: worktreeMode == null ? null : path,
    oldMode,
    newMode: worktreeMode,
    oldOid: normalizeOid(oursOidRaw),
    newOid: null,
    submoduleState: normalizeSubmoduleState(submoduleRaw),
    source: "tracked",
  };
}

export function parsePorcelainV2(output: Buffer): ParsedGitChange[] {
  const records = splitNulBuffers(output, "git status porcelain output");
  const changes: ParsedGitChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const recordType = String.fromCharCode(record[0] ?? 0);

    if (recordType === "1") {
      const change = parseOrdinaryStatusRecord(record);
      if (change != null) changes.push(change);
      continue;
    }
    if (recordType === "2") {
      const originalPathRecord = records[index + 1];
      if (originalPathRecord == null) throw new Error("Porcelain rename record is missing its original path.");
      const change = parseRenameStatusRecord(record, originalPathRecord);
      if (change != null) changes.push(change);
      index += 1;
      continue;
    }
    if (recordType === "u") {
      changes.push(parseUnmergedStatusRecord(record));
      continue;
    }
    if (recordType === "?") {
      if (record[1] !== 0x20) throw new Error("Malformed porcelain untracked record.");
      const path = decodeUtf8(record.subarray(2), "porcelain untracked path");
      changes.push({
        status: "added",
        oldPath: null,
        newPath: path,
        oldMode: null,
        newMode: null,
        oldOid: null,
        newOid: null,
        submoduleState: null,
        source: "untracked",
      });
      continue;
    }
    if (recordType === "!") continue;
    throw new Error(`Unsupported porcelain v2 record type ${JSON.stringify(recordType)}.`);
  }

  return changes;
}

function parseRawHeader(record: Buffer): {
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
  rawStatus: string;
} {
  const header = decodeUtf8(record, "raw diff header");
  const fields = header.split(" ");
  if (fields.length !== 5 || !fields[0]?.startsWith(":")) throw new Error("Malformed raw diff header.");
  const [oldModeWithPrefix, newModeRaw, oldOidRaw, newOidRaw, rawStatus] = fields;
  if (newModeRaw == null || oldOidRaw == null || newOidRaw == null || rawStatus == null) throw new Error("Malformed raw diff header.");
  return {
    oldMode: normalizeMode(oldModeWithPrefix.slice(1)),
    newMode: normalizeMode(newModeRaw),
    oldOid: normalizeOid(oldOidRaw),
    newOid: normalizeOid(newOidRaw),
    rawStatus,
  };
}

function statusFromRawCode(code: string): ChangeStatus {
  switch (code) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    case "U": return "conflicted";
    default: throw new Error(`Unsupported raw diff status ${JSON.stringify(code)}.`);
  }
}

export function parseRawDiff(output: Buffer): ParsedGitChange[] {
  const records = splitNulBuffers(output, "git raw diff output");
  const changes: ParsedGitChange[] = [];

  for (let index = 0; index < records.length;) {
    const header = parseRawHeader(records[index]);
    index += 1;
    const code = header.rawStatus[0] ?? "";
    const status = statusFromRawCode(code);

    if (status === "renamed" || status === "copied") {
      const oldPathRecord = records[index];
      const newPathRecord = records[index + 1];
      if (oldPathRecord == null || newPathRecord == null) throw new Error("Raw rename/copy record is missing a path.");
      changes.push({
        status,
        oldPath: decodeUtf8(oldPathRecord, "raw old path"),
        newPath: decodeUtf8(newPathRecord, "raw new path"),
        oldMode: header.oldMode,
        newMode: header.newMode,
        oldOid: header.oldOid,
        newOid: header.newOid,
        submoduleState: null,
        source: "tracked",
      });
      index += 2;
      continue;
    }

    const pathRecord = records[index];
    if (pathRecord == null) throw new Error("Raw diff record is missing its path.");
    const path = decodeUtf8(pathRecord, "raw diff path");
    changes.push({
      status,
      oldPath: status === "added" ? null : path,
      newPath: status === "deleted" ? null : path,
      oldMode: header.oldMode,
      newMode: header.newMode,
      oldOid: header.oldOid,
      newOid: header.newOid,
      submoduleState: null,
      source: "tracked",
    });
    index += 1;
  }

  return changes;
}

function validateRepoPath(path: string): void {
  if (path.length === 0 || isAbsolute(path) || path.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid repository path ${JSON.stringify(path)}.`);
  }
}

function resolveRepoPath(root: string, path: string): string {
  validateRepoPath(path);
  const absolutePath = resolve(root, ...path.split("/"));
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Repository path escapes its root: ${JSON.stringify(path)}.`);
  }
  return absolutePath;
}

function gitModeFromStats(stats: Stats): string | null {
  if (stats.isSymbolicLink()) return "120000";
  if (stats.isFile()) return (stats.mode & 0o111) === 0 ? "100644" : "100755";
  if (stats.isDirectory()) return "040000";
  return null;
}

async function hydrateUntrackedModes(
  root: string,
  changes: ParsedGitChange[],
  signal?: AbortSignal,
): Promise<void> {
  const untrackedChanges = changes.filter((change) => change.source === "untracked" && change.newPath != null);
  let nextIndex = 0;
  const workerCount = Math.min(16, untrackedChanges.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      const change = untrackedChanges[index];
      if (change == null || change.newPath == null) return;
      try {
        change.newMode = gitModeFromStats(await lstat(resolveRepoPath(root, change.newPath)));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }));
}

export function mergeUncommittedChanges(changes: readonly ParsedGitChange[]): ParsedGitChange[] {
  const untrackedByPath = new Map<string, ParsedGitChange>();
  for (const change of changes) {
    if (change.source === "untracked" && change.newPath != null) untrackedByPath.set(change.newPath, change);
  }

  const consumed = new Set<ParsedGitChange>();
  const recreationByDeletion = new Map<ParsedGitChange, ParsedGitChange>();
  for (const change of changes) {
    if (change.source === "tracked" && change.oldPath != null && change.newPath == null) {
      const recreation = untrackedByPath.get(change.oldPath);
      if (recreation != null) {
        consumed.add(recreation);
        recreationByDeletion.set(change, recreation);
      }
    }
  }

  const merged: ParsedGitChange[] = [];
  for (const change of changes) {
    if (consumed.has(change)) continue;
    const recreation = recreationByDeletion.get(change);
    if (recreation != null) {
      merged.push({
        status: modeType(change.oldMode) !== modeType(recreation.newMode) ? "type-changed" : "modified",
        oldPath: change.oldPath,
        newPath: recreation.newPath,
        oldMode: change.oldMode,
        newMode: recreation.newMode,
        oldOid: change.oldOid,
        newOid: null,
        submoduleState: change.submoduleState ?? recreation.submoduleState,
        source: "tracked",
      });
      continue;
    }
    merged.push(change);
  }

  return merged;
}

function contextKey(mode: "uncommitted" | "compare", parts: readonly string[]): string {
  return `${mode}:${stableHash([mode, ...parts])}`;
}

function workspaceFilePath(repo: DiscoveredRepository, path: string): string {
  return repo.workspacePath === "." ? path : `${repo.workspacePath}/${path}`;
}

function displayPath(change: ParsedGitChange): string {
  if ((change.status === "renamed" || change.status === "copied") && change.oldPath != null && change.newPath != null) {
    return `${change.oldPath} -> ${change.newPath}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function buildReviewFiles(
  repo: DiscoveredRepository,
  context: ReviewContext,
  changes: readonly ParsedGitChange[],
): ReviewFile[] {
  return changes
    .map((change): ReviewFile => {
      const canonicalPath = change.newPath ?? change.oldPath;
      if (canonicalPath == null) throw new Error("Git change has neither an old nor a new path.");
      return {
        id: `${repo.id}:${stableHash([context.key, change.status, change.oldPath ?? "", change.newPath ?? ""]).slice(0, 24)}`,
        repositoryId: repo.id,
        workspacePath: workspaceFilePath(repo, canonicalPath),
        status: change.status,
        oldPath: change.oldPath,
        newPath: change.newPath,
        displayPath: displayPath(change),
        oldMode: change.oldMode,
        newMode: change.newMode,
        oldOid: change.oldOid,
        newOid: change.newOid,
        submoduleState: change.submoduleState,
      };
    })
    .sort((a, b) => compareStrings(a.workspacePath, b.workspacePath) || compareStrings(a.id, b.id));
}

async function tryResolveCommit(repoRoot: string, ref: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], signal, [0, 1]);
  if (result.code === 1) return null;
  const oid = decodeUtf8(result.stdout, "commit object id").trim();
  if (!OBJECT_ID_PATTERN.test(oid)) throw new Error(`Git returned an invalid object id for ${JSON.stringify(ref)}.`);
  return oid;
}

async function resolveCommit(repoRoot: string, ref: string, signal?: AbortSignal): Promise<string> {
  if (ref.trim().length === 0) throw new Error("Commit reference cannot be empty.");
  const oid = await tryResolveCommit(repoRoot, ref, signal);
  if (oid == null) throw new Error(`Invalid local commit reference ${JSON.stringify(ref)}.`);
  return oid;
}

async function tryResolveSymbolicRef(
  repoRoot: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", ref], signal, [0, 1]);
  if (result.code === 1) return null;
  const target = decodeUtf8(result.stdout, `symbolic reference ${ref}`).trim();
  return target.length === 0 ? null : target;
}

async function currentBranchUpstreamRemote(repoRoot: string, signal?: AbortSignal): Promise<string | null> {
  const branchResult = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal, [0, 1]);
  if (branchResult.code === 1) return null;
  const branch = decodeUtf8(branchResult.stdout, "current branch name").trim();
  if (branch.length === 0) return null;

  const [remoteResult, mergeResult] = await Promise.all([
    runGit(repoRoot, ["config", "--get", `branch.${branch}.remote`], signal, [0, 1]),
    runGit(repoRoot, ["config", "--get", `branch.${branch}.merge`], signal, [0, 1]),
  ]);
  if (remoteResult.code === 1 || mergeResult.code === 1) return null;
  const remote = decodeUtf8(remoteResult.stdout, "upstream remote name").trim();
  return remote.length === 0 || remote === "." ? null : remote;
}

interface RemoteHeadRef {
  ref: string;
  target: string;
}

async function listRemoteHeadRefs(repoRoot: string, signal?: AbortSignal): Promise<RemoteHeadRef[]> {
  const result = await runGit(
    repoRoot,
    ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"],
    signal,
  );
  const lines = decodeUtf8(result.stdout, "remote reference list").split("\n");
  const heads: RemoteHeadRef[] = [];

  for (const line of lines) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const ref = line.slice(0, separator);
    const target = line.slice(separator + 1);
    if (!ref.startsWith("refs/remotes/") || !ref.endsWith("/HEAD") || target.length === 0) continue;
    heads.push({
      ref,
      target: target.startsWith("refs/remotes/") ? target.slice("refs/remotes/".length) : target,
    });
  }

  return heads.sort((a, b) => compareStrings(a.ref, b.ref));
}

async function resolveDefaultBase(repoRoot: string, signal?: AbortSignal): Promise<string | null> {
  const triedRemoteHeads = new Set<string>();
  const tryRemoteHead = async (ref: string): Promise<string | null> => {
    triedRemoteHeads.add(ref);
    const candidate = await tryResolveSymbolicRef(repoRoot, ref, signal);
    return candidate != null && await tryResolveCommit(repoRoot, candidate, signal) != null ? candidate : null;
  };

  const originHead = await tryRemoteHead("refs/remotes/origin/HEAD");
  if (originHead != null) return originHead;

  const upstreamRemote = await currentBranchUpstreamRemote(repoRoot, signal);
  if (upstreamRemote != null) {
    const upstreamHead = await tryRemoteHead(`refs/remotes/${upstreamRemote}/HEAD`);
    if (upstreamHead != null) return upstreamHead;
  }

  for (const remoteHead of await listRemoteHeadRefs(repoRoot, signal)) {
    if (triedRemoteHeads.has(remoteHead.ref)) continue;
    if (await tryResolveCommit(repoRoot, remoteHead.target, signal) != null) return remoteHead.target;
  }

  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    if (await tryResolveCommit(repoRoot, candidate, signal) != null) return candidate;
  }
  return null;
}

export async function inspectRepository(
  repo: DiscoveredRepository,
  signal?: AbortSignal,
): Promise<ReviewRepositoryData> {
  throwIfAborted(signal);
  const [headOid, baseRef, statusResult] = await Promise.all([
    tryResolveCommit(repo.root, "HEAD", signal),
    resolveDefaultBase(repo.root, signal),
    runGit(repo.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"], signal),
  ]);
  const parsedChanges = parsePorcelainV2(statusResult.stdout);
  await hydrateUntrackedModes(repo.root, parsedChanges, signal);
  const changes = mergeUncommittedChanges(parsedChanges);
  const statusDigest = createHash("sha256").update(statusResult.stdout).digest("hex");
  const context: ReviewContext = {
    key: contextKey("uncommitted", [repo.id, headOid ?? "unborn", statusDigest]),
    mode: "uncommitted",
    repositoryId: repo.id,
    baseRef: "HEAD",
    headRef: "WORKTREE",
    ...(headOid == null ? {} : { baseOid: headOid }),
  };

  return {
    id: repo.id,
    name: repo.name,
    workspacePath: repo.workspacePath,
    baseRef,
    headRef: "HEAD",
    headOid,
    uncommitted: {
      context,
      files: buildReviewFiles(repo, context, changes),
    },
  };
}

export async function loadComparison(
  repo: DiscoveredRepository,
  baseRef: string,
  headRef: string,
  signal?: AbortSignal,
): Promise<ReviewComparisonData> {
  throwIfAborted(signal);
  const [baseOid, headOid] = await Promise.all([
    resolveCommit(repo.root, baseRef, signal),
    resolveCommit(repo.root, headRef, signal),
  ]);
  const mergeBaseResult = await runGit(repo.root, ["merge-base", baseOid, headOid], signal, [0, 1]);
  if (mergeBaseResult.code === 1) {
    throw new Error(`No merge base exists between ${JSON.stringify(baseRef)} and ${JSON.stringify(headRef)}.`);
  }
  const mergeBaseOid = decodeUtf8(mergeBaseResult.stdout, "merge-base object id").trim();
  if (!OBJECT_ID_PATTERN.test(mergeBaseOid)) throw new Error("Git returned an invalid merge-base object id.");

  const diffResult = await runGit(
    repo.root,
    ["diff", "--raw", "--no-abbrev", "-z", "--find-renames", "--find-copies-harder", mergeBaseOid, headOid, "--"],
    signal,
  );
  const changes = parseRawDiff(diffResult.stdout);
  const context: ReviewContext = {
    key: contextKey("compare", [repo.id, baseOid, headOid, mergeBaseOid]),
    mode: "compare",
    repositoryId: repo.id,
    baseRef,
    headRef,
    baseOid,
    headOid,
    mergeBaseOid,
  };

  return {
    repositoryId: repo.id,
    baseRef,
    headRef,
    baseOid,
    headOid,
    mergeBaseOid,
    changeSet: {
      context,
      files: buildReviewFiles(repo, context, changes),
    },
  };
}

function isGitlinkMode(mode: string | null): boolean {
  return mode === "160000";
}

function isSymlinkMode(mode: string | null): boolean {
  return mode === "120000";
}

function isRegularMode(mode: string | null): boolean {
  return mode?.startsWith("100") === true;
}

function validateObjectId(oid: string): void {
  if (!OBJECT_ID_PATTERN.test(oid)) throw new Error(`Invalid Git object id ${JSON.stringify(oid)}.`);
}

function loadBlobContent(repoRoot: string, oid: string, signal?: AbortSignal): Promise<ReviewContent> {
  validateObjectId(oid);
  throwIfAborted(signal);

  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["cat-file", "blob", oid];
    const child = spawn("git", args, {
      cwd: repoRoot,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const textChunks: string[] = [];
    const stderrChunks: Buffer[] = [];
    let binary = false;
    let aborted = false;
    let settled = false;

    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const markBinary = (): void => {
      if (binary) return;
      binary = true;
      textChunks.length = 0;
      child.kill();
    };
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };

    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
    child.stdout.on("data", (chunk: Buffer) => {
      if (binary) return;
      if (chunk.includes(0)) {
        markBinary();
        return;
      }
      try {
        textChunks.push(decoder.decode(chunk, { stream: true }));
      } catch {
        markBinary();
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once("error", (error) => rejectOnce(new GitCommandError(args, null, error.message)));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        rejectPromise(createAbortError());
        return;
      }
      if (binary) {
        resolvePromise({ kind: "binary" });
        return;
      }
      if (code !== 0) {
        rejectPromise(new GitCommandError(args, code, decodeForError(Buffer.concat(stderrChunks))));
        return;
      }
      try {
        textChunks.push(decoder.decode());
        resolvePromise({ kind: "text", text: textChunks.join("") });
      } catch {
        resolvePromise({ kind: "binary" });
      }
    });
  });
}

async function loadSymlinkBlob(repoRoot: string, oid: string, signal?: AbortSignal): Promise<ReviewContent> {
  validateObjectId(oid);
  const result = await runGit(repoRoot, ["cat-file", "blob", oid], signal);
  return { kind: "symlink", text: new TextDecoder("utf-8").decode(result.stdout) };
}

async function inspectPathWithoutFollowingDirectories(
  repoRoot: string,
  repoPath: string,
): Promise<{ absolutePath: string; stats: Stats } | { special: string } | null> {
  validateRepoPath(repoPath);
  const parts = repoPath.split("/");
  let current = repoRoot;

  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let currentStats;
    try {
      currentStats = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (index < parts.length - 1 && currentStats.isSymbolicLink()) {
      return { special: `Cannot review ${repoPath} because an intermediate directory is a symbolic link.` };
    }
    if (index === parts.length - 1) return { absolutePath: current, stats: currentStats };
  }
  return null;
}

async function classifyRegularFile(
  absolutePath: string,
  signal?: AbortSignal,
): Promise<ReviewContent> {
  throwIfAborted(signal);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);

  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return { kind: "special", message: "Path changed while it was being loaded." };
    const byteLength = openedStats.size;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const textChunks: string[] = [];
    const stream = handle.createReadStream({ autoClose: false });

    for await (const rawChunk of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (chunk.includes(0)) return { kind: "binary", byteLength };
      try {
        textChunks.push(decoder.decode(chunk, { stream: true }));
      } catch {
        return { kind: "binary", byteLength };
      }
    }

    try {
      textChunks.push(decoder.decode());
      return { kind: "text", text: textChunks.join("") };
    } catch {
      return { kind: "binary", byteLength };
    }
  } finally {
    await handle.close();
  }
}

async function loadRevisionContent(
  repo: DiscoveredRepository,
  path: string | null,
  mode: string | null,
  oid: string | null,
  signal?: AbortSignal,
): Promise<ReviewContent> {
  throwIfAborted(signal);
  if (path == null) return { kind: "missing" };
  if (oid == null) return { kind: "special", message: `Git did not provide an object id for ${path}.` };
  if (isGitlinkMode(mode)) return { kind: "gitlink", text: oid };
  if (isSymlinkMode(mode)) return loadSymlinkBlob(repo.root, oid, signal);
  if (!isRegularMode(mode)) return { kind: "special", message: `Unsupported Git mode ${mode ?? "unknown"}.` };
  return loadBlobContent(repo.root, oid, signal);
}

async function loadWorkingTreeContent(
  repo: DiscoveredRepository,
  path: string | null,
  mode: string | null,
  fallbackOid: string | null,
  submoduleState: string | null,
  signal?: AbortSignal,
): Promise<ReviewContent> {
  throwIfAborted(signal);
  if (path == null) return { kind: "missing" };
  const inspected = await inspectPathWithoutFollowingDirectories(repo.root, path);
  if (inspected == null) {
    return fallbackOid == null ? { kind: "missing" } : loadRevisionContent(repo, path, mode, fallbackOid, signal);
  }
  if ("special" in inspected) return { kind: "special", message: inspected.special };
  if (inspected.stats.isSymbolicLink()) {
    return { kind: "symlink", text: await readlink(inspected.absolutePath, "utf8") };
  }
  if (isGitlinkMode(mode) && inspected.stats.isDirectory()) {
    const formatGitlink = (oid: string): ReviewContent => {
      if (submoduleState == null) return { kind: "gitlink", text: oid };
      const details = [
        submoduleState[1] === "C" ? "checked-out commit changed" : null,
        submoduleState[2] === "M" ? "modified tracked files" : null,
        submoduleState[3] === "U" ? "untracked files" : null,
      ].filter((detail): detail is string => detail != null);
      return details.length === 0
        ? { kind: "gitlink", text: oid }
        : { kind: "gitlink", text: `${oid}\n[Submodule worktree: ${details.join(", ")}]` };
    };
    const worktreeOid = await tryResolveCommit(inspected.absolutePath, "HEAD", signal);
    if (worktreeOid != null) return formatGitlink(worktreeOid);
    return fallbackOid == null
      ? { kind: "special", message: `Could not resolve the submodule object id for ${path}.` }
      : formatGitlink(fallbackOid);
  }
  if (inspected.stats.isFile()) {
    return classifyRegularFile(inspected.absolutePath, signal);
  }
  return { kind: "special", message: `${path} is not a regular file or symbolic link.` };
}

function expectedFileId(repo: DiscoveredRepository, context: ReviewContext, file: ReviewFile): string {
  return `${repo.id}:${stableHash([context.key, file.status, file.oldPath ?? "", file.newPath ?? ""]).slice(0, 24)}`;
}

export async function loadReviewFileContents(
  repo: DiscoveredRepository,
  context: ReviewContext,
  file: ReviewFile,
  signal?: AbortSignal,
): Promise<ReviewFileContents> {
  throwIfAborted(signal);
  if (repo.id !== context.repositoryId || repo.id !== file.repositoryId) {
    throw new Error("Repository, context, and file identifiers do not match.");
  }
  if (file.id !== expectedFileId(repo, context, file)) {
    throw new Error("File does not belong to the requested review context.");
  }

  const original = await loadRevisionContent(repo, file.oldPath, file.oldMode, file.oldOid, signal);
  const modified = context.mode === "uncommitted"
    ? await loadWorkingTreeContent(repo, file.newPath, file.newMode, file.newOid, file.submoduleState, signal)
    : await loadRevisionContent(repo, file.newPath, file.newMode, file.newOid, signal);
  return { original, modified };
}
