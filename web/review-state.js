globalThis.__piDiffReviewState = (() => {
  "use strict";

  function contextIndexKey(repositoryId, contextKey) {
    return JSON.stringify([repositoryId, contextKey]);
  }

  function viewKey(repositoryId, contextKey, fileId) {
    return JSON.stringify([repositoryId, contextKey, fileId]);
  }

  function directoryKey(mode, repositoryId, contextKey, path) {
    return JSON.stringify([mode, repositoryId, contextKey, path]);
  }

  function repositoryCollapseKey(mode, repositoryId) {
    return JSON.stringify([mode, repositoryId]);
  }

  function getFilePath(file) {
    return file?.newPath || file?.oldPath || file?.displayPath || "(unknown)";
  }

  function buildFileTree(files) {
    const root = { name: "", path: "", file: null, children: new Map() };
    for (const file of files) {
      const parts = getFilePath(file).split("/").filter(Boolean);
      let node = root;
      let currentPath = "";
      parts.forEach((part, index) => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, path: currentPath, file: null, children: new Map() });
        }
        node = node.children.get(part);
        if (index === parts.length - 1) node.file = file;
      });
    }
    return root;
  }

  function createCompareState(repository) {
    return {
      repositoryId: repository.id,
      baseInput: repository.baseRef || "",
      headInput: repository.headRef || "",
      acceptedBaseRef: null,
      acceptedHeadRef: null,
      pendingBaseRef: null,
      pendingHeadRef: null,
      latestRequestId: null,
      loading: false,
      error: null,
      comparison: null,
    };
  }

  function beginComparison(compareState, requestId, baseRef, headRef) {
    return {
      ...compareState,
      baseInput: baseRef,
      headInput: headRef,
      latestRequestId: requestId,
      loading: true,
      error: null,
      pendingBaseRef: baseRef,
      pendingHeadRef: headRef,
    };
  }

  function receiveComparison(compareState, message) {
    if (
      !compareState
      || compareState.repositoryId !== message.repositoryId
      || compareState.latestRequestId !== message.requestId
    ) return null;
    return { ...compareState, loading: false };
  }

  function rejectComparison(compareState, message) {
    const received = receiveComparison(compareState, message);
    return received == null
      ? null
      : { ...received, error: message.message || "Failed to compare refs." };
  }

  function acceptComparison(compareState, comparison) {
    if (
      !compareState
      || comparison?.repositoryId !== compareState.repositoryId
      || !comparison?.changeSet?.context?.key
    ) return null;
    const baseInput = comparison.baseRef || compareState.pendingBaseRef || "";
    const headInput = comparison.headRef || compareState.pendingHeadRef || "";
    return {
      ...compareState,
      comparison,
      loading: false,
      error: null,
      baseInput,
      headInput,
      acceptedBaseRef: baseInput,
      acceptedHeadRef: headInput,
    };
  }

  function restoreComparisonInputs(compareState, comparison) {
    return {
      ...compareState,
      baseInput: comparison?.baseRef || compareState.acceptedBaseRef || "",
      headInput: comparison?.headRef || compareState.acceptedHeadRef || "",
      error: null,
    };
  }

  function settleFileLoad(load, message, status) {
    if (
      !load
      || load.status !== "loading"
      || load.requestId !== message.requestId
      || load.repositoryId !== message.repositoryId
      || load.contextKey !== message.contextKey
      || load.fileId !== message.fileId
    ) return null;
    const settled = {
      status,
      requestId: null,
      repositoryId: load.repositoryId,
      contextKey: load.contextKey,
      fileId: load.fileId,
      mode: load.mode,
    };
    if (status === "ready") settled.contents = message.contents;
    else settled.message = message.message || "Failed to load file.";
    return settled;
  }

  return Object.freeze({
    acceptComparison,
    beginComparison,
    buildFileTree,
    contextIndexKey,
    createCompareState,
    directoryKey,
    getFilePath,
    receiveComparison,
    rejectComparison,
    repositoryCollapseKey,
    restoreComparisonInputs,
    settleFileLoad,
    viewKey,
  });
})();
