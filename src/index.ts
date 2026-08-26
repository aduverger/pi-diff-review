import { availableParallelism } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { open, type GlimpseWindow } from "glimpseui";
import {
  discoverRepositories,
  inspectRepository,
  loadComparison,
  loadReviewFileContents,
} from "./git.js";
import { createInvocationCleanup, type InvocationCleanup } from "./lifecycle.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  DiffReviewComment,
  DiscoveredRepository,
  ReviewChangeSet,
  ReviewContext,
  ReviewFile,
  ReviewHostMessage,
  ReviewRepositoryData,
  ReviewRequestComparePayload,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
} from "./types.js";
import {
  buildHostMessageScript,
  buildReviewHtml,
  decodeReviewWindowMessage,
} from "./ui.js";

const MAX_CONCURRENT_REPOSITORY_OPERATIONS = 4;

interface RegisteredContext {
  context: ReviewContext;
  filesById: Map<string, ReviewFile>;
}

interface RegisteredRepository {
  discovered: DiscoveredRepository;
  contextsByKey: Map<string, RegisteredContext>;
  latestComparisonRequestId?: string;
  comparisonAbortController?: AbortController;
}

interface ActiveInvocation {
  window: GlimpseWindow;
  cancelled: boolean;
  cancelAndClose(): void;
}

type TerminalResult =
  | { kind: "submit"; payload: ReviewSubmitPayload }
  | { kind: "cancel" }
  | { kind: "error"; error: Error };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerContext(repositoryId: string, changeSet: ReviewChangeSet): RegisteredContext {
  if (changeSet.context.repositoryId !== repositoryId) {
    throw new Error("Review context belongs to a different repository.");
  }
  if (changeSet.context.key.length === 0) {
    throw new Error("Review context is missing its key.");
  }

  const filesById = new Map<string, ReviewFile>();
  for (const file of changeSet.files) {
    if (file.repositoryId !== repositoryId) {
      throw new Error(`Review file ${file.id} belongs to a different repository.`);
    }
    if (file.id.length === 0 || filesById.has(file.id)) {
      throw new Error(`Invalid or duplicate review file id: ${file.id}`);
    }
    filesById.set(file.id, file);
  }
  return { context: changeSet.context, filesById };
}

function findContext(repository: RegisteredRepository, contextKey: string): RegisteredContext | undefined {
  return repository.contextsByKey.get(contextKey);
}

async function runConcurrently<T>(values: readonly T[], worker: (value: T, index: number) => Promise<void>): Promise<void> {
  if (values.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.min(values.length, MAX_CONCURRENT_REPOSITORY_OPERATIONS, availableParallelism());
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(values[index]!, index);
      }
    }),
  );
}

function failedRepositoryData(repository: DiscoveredRepository, error: unknown): ReviewRepositoryData {
  return {
    id: repository.id,
    name: repository.name,
    workspacePath: repository.workspacePath,
    baseRef: null,
    headRef: "HEAD",
    headOid: null,
    uncommitted: null,
    error: errorMessage(error),
  };
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {}
}

export default function (pi: ExtensionAPI) {
  let activeInvocation: ActiveInvocation | null = null;

  async function reviewWorkspace(ctx: ExtensionCommandContext): Promise<void> {
    if (activeInvocation != null) {
      notify(ctx, "A review window is already open.", "warning");
      return;
    }

    const abortController = new AbortController();
    let invocation: ActiveInvocation | null = null;
    let lifecycle: InvocationCleanup | null = null;
    let editorUpdated = false;

    try {
      const window = open(buildReviewHtml({ workspaceRoot: ctx.cwd }), {
        width: 1680,
        height: 1020,
        title: "pi review",
      });

      const repositories = new Map<string, RegisteredRepository>();
      let terminalSettled = false;
      let windowClosed = false;
      let pageReady = false;
      let removeWindowListeners = (): void => {};
      const pendingMessages: ReviewHostMessage[] = [];
      lifecycle = createInvocationCleanup({
        abort: () => abortController.abort(),
        close: () => {
          if (windowClosed) return;
          window.close();
        },
        removeListeners: () => removeWindowListeners(),
      });
      const currentLifecycle = lifecycle;
      let settleTerminal!: (result: TerminalResult) => void;
      const terminalPromise = new Promise<TerminalResult>((resolve) => {
        settleTerminal = (result): void => {
          if (terminalSettled) return;
          terminalSettled = true;
          currentLifecycle.abort();
          resolve(result);
        };
      });

      invocation = {
        window,
        cancelled: false,
        cancelAndClose(): void {
          this.cancelled = true;
          settleTerminal({ kind: "cancel" });
          currentLifecycle.close();
        },
      };
      const currentInvocation = invocation;
      activeInvocation = currentInvocation;

      const canSend = (): boolean =>
        activeInvocation === currentInvocation && !terminalSettled && !abortController.signal.aborted;

      const sendWindowMessage = (message: ReviewHostMessage): void => {
        if (!canSend()) return;
        if (!pageReady) {
          pendingMessages.push(message);
          return;
        }
        window.send(buildHostMessageScript(message));
      };

      const handleAsyncFailure = (error: unknown): void => {
        if (!abortController.signal.aborted) {
          settleTerminal({ kind: "error", error: new Error(errorMessage(error)) });
        }
      };

      const flushPendingMessages = (): void => {
        if (!canSend()) return;
        pageReady = true;
        for (const message of pendingMessages.splice(0)) {
          window.send(buildHostMessageScript(message));
        }
      };

      const isRegisteredContext = (repository: RegisteredRepository, registered: RegisteredContext): boolean =>
        repository.contextsByKey.get(registered.context.key) === registered;

      const sendCompareError = (message: ReviewRequestComparePayload, error: unknown): void => {
        sendWindowMessage({
          type: "compare-error",
          requestId: message.requestId,
          repositoryId: message.repositoryId,
          baseRef: message.baseRef,
          headRef: message.headRef,
          message: errorMessage(error),
        });
      };

      const executeCompareRequest = async (
        repository: RegisteredRepository,
        message: ReviewRequestComparePayload,
      ): Promise<void> => {
        const comparisonAbortController = new AbortController();
        repository.comparisonAbortController = comparisonAbortController;
        try {
          const comparison = await loadComparison(
            repository.discovered,
            message.baseRef,
            message.headRef,
            AbortSignal.any([abortController.signal, comparisonAbortController.signal]),
          );
          if (!canSend() || repository.latestComparisonRequestId !== message.requestId) return;
          const registered = repository.contextsByKey.get(comparison.changeSet.context.key)
            ?? registerContext(repository.discovered.id, comparison.changeSet);
          if (!canSend() || repository.latestComparisonRequestId !== message.requestId) return;
          registered.context = comparison.changeSet.context;
          repository.contextsByKey.set(registered.context.key, registered);
          sendWindowMessage({
            type: "compare-data",
            requestId: message.requestId,
            repositoryId: message.repositoryId,
            comparison,
          });
        } catch (error) {
          if (!canSend() || repository.latestComparisonRequestId !== message.requestId) return;
          sendCompareError(message, error);
        } finally {
          if (repository.comparisonAbortController === comparisonAbortController) {
            repository.comparisonAbortController = undefined;
          }
        }
      };

      const pendingComparisons = new Map<string, ReviewRequestComparePayload>();
      const queuedRepositoryIds: string[] = [];
      const queuedRepositories = new Set<string>();
      const activeComparisonRepositories = new Set<string>();
      const comparisonConcurrency = Math.max(1, Math.min(MAX_CONCURRENT_REPOSITORY_OPERATIONS, availableParallelism()));
      let activeComparisonCount = 0;

      const clearComparisonQueue = (): void => {
        pendingComparisons.clear();
        queuedRepositoryIds.length = 0;
        queuedRepositories.clear();
      };

      const drainComparisonQueue = (): void => {
        if (abortController.signal.aborted) {
          clearComparisonQueue();
          return;
        }

        while (activeComparisonCount < comparisonConcurrency && queuedRepositoryIds.length > 0) {
          const repositoryId = queuedRepositoryIds.shift()!;
          queuedRepositories.delete(repositoryId);
          const message = pendingComparisons.get(repositoryId);
          pendingComparisons.delete(repositoryId);
          const repository = repositories.get(repositoryId);
          if (message == null || repository?.latestComparisonRequestId !== message.requestId) continue;

          activeComparisonCount += 1;
          activeComparisonRepositories.add(repositoryId);
          void executeCompareRequest(repository, message)
            .catch(handleAsyncFailure)
            .finally(() => {
              activeComparisonCount -= 1;
              activeComparisonRepositories.delete(repositoryId);
              if (
                !abortController.signal.aborted
                && pendingComparisons.has(repositoryId)
                && !queuedRepositories.has(repositoryId)
              ) {
                queuedRepositoryIds.push(repositoryId);
                queuedRepositories.add(repositoryId);
              }
              drainComparisonQueue();
            });
        }
      };

      const queueCompareRequest = (message: ReviewRequestComparePayload): void => {
        const repository = repositories.get(message.repositoryId);
        if (repository == null) {
          sendCompareError(message, new Error("Unknown repository requested."));
          return;
        }

        repository.latestComparisonRequestId = message.requestId;
        repository.comparisonAbortController?.abort();
        pendingComparisons.set(message.repositoryId, message);
        if (
          !activeComparisonRepositories.has(message.repositoryId)
          && !queuedRepositories.has(message.repositoryId)
        ) {
          queuedRepositoryIds.push(message.repositoryId);
          queuedRepositories.add(message.repositoryId);
        }
        drainComparisonQueue();
      };

      abortController.signal.addEventListener("abort", clearComparisonQueue, { once: true });

      const sendFileError = (message: ReviewRequestFilePayload, error: unknown): void => {
        sendWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          repositoryId: message.repositoryId,
          contextKey: message.contextKey,
          fileId: message.fileId,
          message: errorMessage(error),
        });
      };

      const handleFileRequest = async (message: ReviewRequestFilePayload): Promise<void> => {
        const repository = repositories.get(message.repositoryId);
        const registered = repository == null ? undefined : findContext(repository, message.contextKey);
        const file = registered?.filesById.get(message.fileId);
        if (repository == null || registered == null || file == null) {
          sendFileError(message, new Error("Unknown or stale review file requested."));
          return;
        }

        try {
          const contents = await loadReviewFileContents(
            repository.discovered,
            registered.context,
            file,
            abortController.signal,
          );
          if (!canSend() || !isRegisteredContext(repository, registered)) return;
          sendWindowMessage({
            type: "file-data",
            requestId: message.requestId,
            repositoryId: message.repositoryId,
            contextKey: message.contextKey,
            fileId: message.fileId,
            contents,
          });
        } catch (error) {
          if (!canSend() || !isRegisteredContext(repository, registered)) return;
          sendFileError(message, error);
        }
      };

      const onMessage = (data: unknown): void => {
        try {
          const message = decodeReviewWindowMessage(data);
          if (message.type === "request-file") {
            void handleFileRequest(message).catch(handleAsyncFailure);
          } else if (message.type === "request-compare") {
            queueCompareRequest(message);
          } else if (message.type === "ready") {
            flushPendingMessages();
          } else if (message.type === "submit") {
            settleTerminal({ kind: "submit", payload: message });
          } else if (message.type === "cancel") {
            settleTerminal({ kind: "cancel" });
          } else {
            settleTerminal({ kind: "error", error: new Error(message.message) });
          }
        } catch (error) {
          settleTerminal({ kind: "error", error: new Error(errorMessage(error)) });
        }
      };

      const onClosed = (): void => {
        windowClosed = true;
        settleTerminal({ kind: "cancel" });
      };

      const onError = (error: Error): void => {
        settleTerminal({ kind: "error", error });
      };

      removeWindowListeners = (): void => {
        window.removeListener("message", onMessage);
        window.removeListener("closed", onClosed);
        window.removeListener("error", onError);
      };

      window.on("message", onMessage);
      window.on("closed", onClosed);
      window.on("error", onError);

      const loadWorkspace = async (): Promise<void> => {
        const discovery = await discoverRepositories(ctx.cwd, abortController.signal);
        const discovered = discovery.repositories;
        for (const repository of discovered) {
          if (repositories.has(repository.id)) {
            throw new Error(`Duplicate repository id: ${repository.id}`);
          }
          repositories.set(repository.id, {
            discovered: repository,
            contextsByKey: new Map(),
          });
        }

        const inspected = new Array<ReviewRepositoryData>(discovered.length);
        await runConcurrently(discovered, async (repository, index) => {
          const registered = repositories.get(repository.id)!;
          try {
            const data = await inspectRepository(repository, abortController.signal);
            if (data.uncommitted != null) {
              const context = registerContext(repository.id, data.uncommitted);
              registered.contextsByKey.set(context.context.key, context);
            }
            inspected[index] = data;
          } catch (error) {
            if (abortController.signal.aborted) throw error;
            const data = failedRepositoryData(repository, error);
            inspected[index] = data;
          }
        });

        sendWindowMessage({
          type: "workspace-data",
          workspaceRoot: discovery.workspaceRoot,
          warnings: discovered.length === 0
            ? [...discovery.warnings, "No Git repositories found in this workspace."]
            : discovery.warnings,
          repositories: inspected,
        });
      };

      void loadWorkspace().catch(handleAsyncFailure);
      notify(ctx, "Opened native review window.", "info");

      const terminal = await terminalPromise;
      if (terminal.kind === "error") throw terminal.error;
      if (terminal.kind === "cancel" || currentInvocation.cancelled) return;
      const submission = {
        ...terminal.payload,
        comments: terminal.payload.comments.filter((comment) => comment.body.trim().length > 0),
      };

      const resolveTarget = (comment: DiffReviewComment) => {
        const repository = repositories.get(comment.repositoryId);
        const registered = repository == null ? undefined : findContext(repository, comment.contextKey);
        const file = registered?.filesById.get(comment.fileId);
        if (
          repository == null ||
          registered == null ||
          file == null ||
          registered.context.mode !== comment.mode
        ) {
          return null;
        }
        return {
          context: registered.context,
          file,
          repositoryPath: repository.discovered.workspacePath,
          repositoryLabel: repository.discovered.name,
        };
      };

      for (const comment of submission.comments) {
        if (resolveTarget(comment) == null) {
          throw new Error(`Unknown or stale comment target: ${comment.id}`);
        }
      }

      const prompt = composeReviewPrompt(submission, resolveTarget);
      if (activeInvocation === currentInvocation && !currentInvocation.cancelled && !editorUpdated) {
        editorUpdated = true;
        ctx.ui.setEditorText(prompt);
        notify(ctx, "Inserted review feedback into the editor.", "info");
      }
    } catch (error) {
      notify(ctx, `Review failed: ${errorMessage(error)}`, "error");
    } finally {
      if (lifecycle) lifecycle.finish();
      else abortController.abort();
      if (activeInvocation === invocation) {
        activeInvocation = null;
      }
    }
  }

  pi.registerCommand("diff-review", {
    description: "Review Uncommitted or Compare changes across workspace repositories",
    handler: async (_args, ctx) => {
      await reviewWorkspace(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    const invocation = activeInvocation;
    invocation?.cancelAndClose();
  });
}
