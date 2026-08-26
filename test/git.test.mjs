import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverRepositories,
  inspectRepository,
  loadComparison,
  loadReviewFileContents,
  mergeUncommittedChanges,
  parsePorcelainV2,
  parseRawDiff,
} from "../src/git.ts";

function execute(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error != null) {
        error.message = `${error.message}\n${stderr}`;
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function git(cwd, ...args) {
  return execute("git", args, cwd);
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createRepository(root) {
  await mkdir(root, { recursive: true });
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.name", "Diff Review Tests");
  await git(root, "config", "user.email", "diff-review@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "config", "core.autocrlf", "false");
  return root;
}

async function commitAll(root, message) {
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", message);
  return (await git(root, "rev-parse", "HEAD")).trim();
}

function byDisplayPath(files) {
  return new Map(files.map((file) => [file.displayPath, file]));
}

test("discovers repository boundaries while pruning generated and symbolic-link directories", async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = join(root, "workspace");
  const first = await createRepository(join(workspace, "first"));
  const second = await createRepository(join(workspace, "nested", "second"));
  await createRepository(join(workspace, "node_modules", "ignored"));
  await createRepository(join(workspace, ".hidden", "ignored"));
  const external = await createRepository(join(root, "external"));
  await symlink(external, join(workspace, "external-link"));

  const discovered = await discoverRepositories(workspace);
  assert.equal(discovered.workspaceRoot, await realpath(workspace));
  assert.deepEqual(
    discovered.repositories.map((repo) => repo.workspacePath),
    ["first", "nested/second"],
  );
  assert.deepEqual(discovered.warnings, []);

  await mkdir(join(first, "src"));
  const fromInside = await discoverRepositories(join(first, "src"));
  assert.equal(fromInside.workspaceRoot, await realpath(first));
  assert.deepEqual(fromInside.repositories.map((repo) => repo.workspacePath), ["."]);
  assert.equal(fromInside.repositories[0].root, await realpath(first));
  assert.notEqual(fromInside.repositories[0].id, discovered.repositories[1].id);
  const resolvedSecond = await realpath(second);
  assert.ok(discovered.repositories.some((repo) => repo.root === resolvedSecond));
});

test("inspects an unborn repository and preserves every valid path byte represented by UTF-8", async (t) => {
  const root = await temporaryDirectory(t);
  const repoRoot = await createRepository(join(root, "repo"));
  await writeFile(join(repoRoot, "staged.txt"), "staged content\n");
  await git(repoRoot, "add", "--", "staged.txt");

  const specialPaths = [
    " leading.txt",
    "line\nbreak.txt",
    "tab\tname.txt",
    "trailing.txt ",
    "unicodé-雪.txt",
  ];
  for (const path of specialPaths) await writeFile(join(repoRoot, path), `${path}\n`);

  const [{ repositories }] = await Promise.all([discoverRepositories(repoRoot)]);
  const repo = repositories[0];
  const inspected = await inspectRepository(repo);
  assert.equal(inspected.headOid, null);
  assert.equal(inspected.baseRef, null);
  assert.equal(inspected.uncommitted.context.mode, "uncommitted");
  assert.ok(inspected.uncommitted.context.key.startsWith("uncommitted:"));

  const filesByPath = new Map(inspected.uncommitted.files.map((file) => [file.newPath, file]));
  assert.deepEqual([...filesByPath.keys()].sort(), ["staged.txt", ...specialPaths].sort());
  assert.ok([...filesByPath.values()].every((file) => file.status === "added"));

  const staged = filesByPath.get("staged.txt");
  assert.equal(staged.oldPath, null);
  assert.match(staged.newOid, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, staged),
    {
      original: { kind: "missing" },
      modified: { kind: "text", text: "staged content\n" },
    },
  );
});

test("resolves default bases from local remote refs in the locked precedence order", async (t) => {
  const root = await temporaryDirectory(t);

  const originRepoRoot = await createRepository(join(root, "origin-main"));
  await writeFile(join(originRepoRoot, "tracked.txt"), "tracked\n");
  const originHeadOid = await commitAll(originRepoRoot, "initial");
  await git(originRepoRoot, "branch", "--move", "feature");
  await git(originRepoRoot, "update-ref", "refs/remotes/origin/main", originHeadOid);
  const originDiscovery = await discoverRepositories(originRepoRoot);
  assert.equal((await inspectRepository(originDiscovery.repositories[0])).baseRef, "origin/main");

  const upstreamRepoRoot = await createRepository(join(root, "upstream-head"));
  await writeFile(join(upstreamRepoRoot, "tracked.txt"), "tracked\n");
  const upstreamHeadOid = await commitAll(upstreamRepoRoot, "initial");
  await git(upstreamRepoRoot, "branch", "--move", "feature");
  await git(upstreamRepoRoot, "update-ref", "refs/remotes/aaa/default", upstreamHeadOid);
  await git(upstreamRepoRoot, "symbolic-ref", "refs/remotes/aaa/HEAD", "refs/remotes/aaa/default");
  await git(upstreamRepoRoot, "update-ref", "refs/remotes/upstream/release", upstreamHeadOid);
  await git(upstreamRepoRoot, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/release");
  await git(upstreamRepoRoot, "config", "branch.feature.remote", "upstream");
  await git(upstreamRepoRoot, "config", "branch.feature.merge", "refs/heads/release");
  const upstreamDiscovery = await discoverRepositories(upstreamRepoRoot);
  assert.equal((await inspectRepository(upstreamDiscovery.repositories[0])).baseRef, "upstream/release");

  const sortedRepoRoot = await createRepository(join(root, "sorted-heads"));
  await writeFile(join(sortedRepoRoot, "tracked.txt"), "tracked\n");
  const sortedHeadOid = await commitAll(sortedRepoRoot, "initial");
  await git(sortedRepoRoot, "branch", "--move", "feature");
  await git(sortedRepoRoot, "update-ref", "refs/remotes/zeta/release", sortedHeadOid);
  await git(sortedRepoRoot, "symbolic-ref", "refs/remotes/zeta/HEAD", "refs/remotes/zeta/release");
  await git(sortedRepoRoot, "update-ref", "refs/remotes/alpha/stable", sortedHeadOid);
  await git(sortedRepoRoot, "symbolic-ref", "refs/remotes/alpha/HEAD", "refs/remotes/alpha/stable");
  const sortedDiscovery = await discoverRepositories(sortedRepoRoot);
  assert.equal((await inspectRepository(sortedDiscovery.repositories[0])).baseRef, "alpha/stable");
});

test("represents tracked changes, renames, type changes, and deletion plus recreation", async (t) => {
  const root = await temporaryDirectory(t);
  const repoRoot = await createRepository(join(root, "repo"));
  await writeFile(join(repoRoot, "modified.txt"), "before modified\n");
  await writeFile(join(repoRoot, "deleted.txt"), "before deleted\n");
  await writeFile(join(repoRoot, "rename-old.txt"), "rename content stays identical\n");
  await writeFile(join(repoRoot, "recreated.txt"), "before recreated\n");
  await writeFile(join(repoRoot, "type.txt"), "before type change\n");
  await commitAll(repoRoot, "baseline");

  await writeFile(join(repoRoot, "modified.txt"), "after modified\n");
  await git(repoRoot, "rm", "--quiet", "--", "deleted.txt");
  await git(repoRoot, "mv", "--", "rename-old.txt", "rename-new.txt");
  await git(repoRoot, "rm", "--quiet", "--cached", "--", "recreated.txt");
  await unlink(join(repoRoot, "type.txt"));
  await symlink("modified.txt", join(repoRoot, "type.txt"));
  await writeFile(join(repoRoot, "staged-then-deleted.txt"), "not in final worktree\n");
  await git(repoRoot, "add", "--", "staged-then-deleted.txt");
  await unlink(join(repoRoot, "staged-then-deleted.txt"));
  await writeFile(join(repoRoot, "new-type.txt"), "staged regular file\n");
  await git(repoRoot, "add", "--", "new-type.txt");
  await unlink(join(repoRoot, "new-type.txt"));
  await symlink("modified.txt", join(repoRoot, "new-type.txt"));

  const { repositories } = await discoverRepositories(repoRoot);
  const repo = repositories[0];
  const inspected = await inspectRepository(repo);
  const files = byDisplayPath(inspected.uncommitted.files);

  assert.equal(files.get("modified.txt").status, "modified");
  assert.equal(files.get("deleted.txt").status, "deleted");
  assert.equal(files.get("rename-old.txt -> rename-new.txt").status, "renamed");
  assert.equal(files.get("recreated.txt").status, "modified");
  assert.equal(files.get("type.txt").status, "type-changed");
  assert.equal(files.get("new-type.txt").status, "added");
  assert.ok(!files.has("staged-then-deleted.txt"));
  assert.equal(inspected.uncommitted.files.length, 6);

  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, files.get("deleted.txt")),
    {
      original: { kind: "text", text: "before deleted\n" },
      modified: { kind: "missing" },
    },
  );
  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, files.get("recreated.txt")),
    {
      original: { kind: "text", text: "before recreated\n" },
      modified: { kind: "text", text: "before recreated\n" },
    },
  );
  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, files.get("type.txt")),
    {
      original: { kind: "text", text: "before type change\n" },
      modified: { kind: "symlink", text: "modified.txt" },
    },
  );
});

test("classifies binary data and reads symbolic links without following them", async (t) => {
  const root = await temporaryDirectory(t);
  const repoRoot = await createRepository(join(root, "repo"));
  const outsidePath = join(root, "outside-secret.txt");
  await writeFile(outsidePath, "must not be read\n");
  await writeFile(join(repoRoot, "nul.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(repoRoot, "invalid-utf8.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
  await symlink(outsidePath, join(repoRoot, "outside-link"));

  const { repositories } = await discoverRepositories(repoRoot);
  const repo = repositories[0];
  const inspected = await inspectRepository(repo);
  const filesByPath = new Map(inspected.uncommitted.files.map((file) => [file.newPath, file]));

  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, filesByPath.get("nul.bin")),
    {
      original: { kind: "missing" },
      modified: { kind: "binary", byteLength: 4 },
    },
  );
  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, filesByPath.get("invalid-utf8.bin")),
    {
      original: { kind: "missing" },
      modified: { kind: "binary", byteLength: 3 },
    },
  );
  assert.deepEqual(
    await loadReviewFileContents(repo, inspected.uncommitted.context, filesByPath.get("outside-link")),
    {
      original: { kind: "missing" },
      modified: { kind: "symlink", text: outsidePath },
    },
  );
});

test("preserves dirty and untracked submodule state without reading nested files", async (t) => {
  const root = await temporaryDirectory(t);
  const childRoot = await createRepository(join(root, "child"));
  await writeFile(join(childRoot, "tracked.txt"), "committed child content\n");
  const childOid = await commitAll(childRoot, "child baseline");

  const parentRoot = await createRepository(join(root, "parent"));
  await git(
    parentRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    childRoot,
    "submodule",
  );
  await commitAll(parentRoot, "add submodule");
  await writeFile(join(parentRoot, "submodule", "tracked.txt"), "dirty child content must not be read\n");
  await writeFile(join(parentRoot, "submodule", "untracked.txt"), "untracked child content must not be read\n");

  const { repositories } = await discoverRepositories(parentRoot);
  const repository = repositories[0];
  const inspected = await inspectRepository(repository);
  const submodule = inspected.uncommitted.files.find((file) => file.newPath === "submodule");
  assert.ok(submodule);
  assert.equal(submodule.status, "modified");
  assert.equal(submodule.submoduleState, "S.MU");
  assert.deepEqual(
    await loadReviewFileContents(repository, inspected.uncommitted.context, submodule),
    {
      original: { kind: "gitlink", text: childOid },
      modified: {
        kind: "gitlink",
        text: `${childOid}\n[Submodule worktree: modified tracked files, untracked files]`,
      },
    },
  );
});

test("compares local commits from their merge base and rejects invalid references", async (t) => {
  const root = await temporaryDirectory(t);
  const repoRoot = await createRepository(join(root, "repo"));
  const initialShared = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const featureShared = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nfeature\n";
  const copiedContent = "unique unchanged copy source content\n".repeat(20);
  await writeFile(join(repoRoot, "shared.txt"), initialShared);
  await writeFile(join(repoRoot, "main-only.txt"), "initial main\n");
  await writeFile(join(repoRoot, "copy-source.txt"), copiedContent);
  const mergeBaseOid = await commitAll(repoRoot, "initial");

  await git(repoRoot, "switch", "--quiet", "-c", "feature");
  await git(repoRoot, "mv", "--", "shared.txt", "feature.txt");
  await writeFile(join(repoRoot, "feature.txt"), featureShared);
  await writeFile(join(repoRoot, "feature.bin"), Buffer.from([0, 1, 2]));
  await symlink("feature.txt", join(repoRoot, "feature-link"));
  await copyFile(join(repoRoot, "copy-source.txt"), join(repoRoot, "copy-target.txt"));
  const featureOid = await commitAll(repoRoot, "feature");

  await git(repoRoot, "switch", "--quiet", "main");
  await writeFile(join(repoRoot, "main-only.txt"), "main divergence\n");
  const mainOid = await commitAll(repoRoot, "main");

  const { repositories } = await discoverRepositories(repoRoot);
  const repo = repositories[0];
  const comparison = await loadComparison(repo, "main", "feature");
  assert.equal(comparison.baseOid, mainOid);
  assert.equal(comparison.headOid, featureOid);
  assert.equal(comparison.mergeBaseOid, mergeBaseOid);
  assert.ok(comparison.changeSet.context.key.startsWith("compare:"));
  assert.equal(comparison.changeSet.context.baseOid, mainOid);
  assert.equal(comparison.changeSet.context.headOid, featureOid);
  assert.ok(!comparison.changeSet.files.some((file) => file.displayPath === "main-only.txt"));

  const featureFile = comparison.changeSet.files.find((file) => file.newPath === "feature.txt");
  assert.ok(featureFile);
  assert.deepEqual(
    await loadReviewFileContents(repo, comparison.changeSet.context, featureFile),
    {
      original: { kind: "text", text: initialShared },
      modified: { kind: "text", text: featureShared },
    },
  );
  const binaryFile = comparison.changeSet.files.find((file) => file.newPath === "feature.bin");
  assert.deepEqual(
    await loadReviewFileContents(repo, comparison.changeSet.context, binaryFile),
    { original: { kind: "missing" }, modified: { kind: "binary" } },
  );
  const symlinkFile = comparison.changeSet.files.find((file) => file.newPath === "feature-link");
  assert.deepEqual(
    await loadReviewFileContents(repo, comparison.changeSet.context, symlinkFile),
    { original: { kind: "missing" }, modified: { kind: "symlink", text: "feature.txt" } },
  );
  const copiedFile = comparison.changeSet.files.find((file) => file.newPath === "copy-target.txt");
  assert.equal(copiedFile.status, "copied");
  assert.equal(copiedFile.oldPath, "copy-source.txt");
  assert.deepEqual(
    await loadReviewFileContents(repo, comparison.changeSet.context, copiedFile),
    {
      original: { kind: "text", text: copiedContent },
      modified: { kind: "text", text: copiedContent },
    },
  );

  await assert.rejects(
    loadComparison(repo, "does-not-exist", "feature"),
    /Invalid local commit reference "does-not-exist"/,
  );
});

test("pure NUL parsers preserve special paths and cover conflicts and copies", () => {
  const oursOid = "2".repeat(40);
  const unmerged = Buffer.from(
    `u UU N... 100644 100644 100644 100644 ${"1".repeat(40)} ${oursOid} ${"3".repeat(40)} conflict\tline\n 雪\0`,
  );
  assert.deepEqual(parsePorcelainV2(unmerged), [{
    status: "conflicted",
    oldPath: "conflict\tline\n 雪",
    newPath: "conflict\tline\n 雪",
    oldMode: "100644",
    newMode: "100644",
    oldOid: oursOid,
    newOid: null,
    submoduleState: null,
    source: "tracked",
  }]);

  const oldOid = "a".repeat(40);
  const newOid = "b".repeat(40);
  const rawCopy = Buffer.from(
    `:100644 100644 ${oldOid} ${newOid} C100\0old\tname\0new\nname \0`,
  );
  assert.deepEqual(parseRawDiff(rawCopy), [{
    status: "copied",
    oldPath: "old\tname",
    newPath: "new\nname ",
    oldMode: "100644",
    newMode: "100644",
    oldOid,
    newOid,
    submoduleState: null,
    source: "tracked",
  }]);

  const deletion = {
    status: "deleted",
    oldPath: "same.txt",
    newPath: null,
    oldMode: "100644",
    newMode: null,
    oldOid,
    newOid: null,
    submoduleState: null,
    source: "tracked",
  };
  const recreation = {
    status: "added",
    oldPath: null,
    newPath: "same.txt",
    oldMode: null,
    newMode: "100644",
    oldOid: null,
    newOid: null,
    submoduleState: null,
    source: "untracked",
  };
  assert.deepEqual(mergeUncommittedChanges([recreation, deletion]), [{
    status: "modified",
    oldPath: "same.txt",
    newPath: "same.txt",
    oldMode: "100644",
    newMode: "100644",
    oldOid,
    newOid: null,
    submoduleState: null,
    source: "tracked",
  }]);
});

test("honors an already-aborted discovery request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverRepositories(".", controller.signal), { name: "AbortError" });
});
