export interface InvocationCleanup {
  abort(): void;
  close(): void;
  removeListeners(): void;
  finish(): void;
}

function once(effect: () => void): () => void {
  let complete = false;
  return () => {
    if (complete) return;
    complete = true;
    try {
      effect();
    } catch {}
  };
}

export function createInvocationCleanup(effects: {
  abort: () => void;
  close: () => void;
  removeListeners: () => void;
}): InvocationCleanup {
  const abort = once(effects.abort);
  const close = once(effects.close);
  const removeListeners = once(effects.removeListeners);
  const finish = once(() => {
    abort();
    close();
    removeListeners();
  });
  return { abort, close, removeListeners, finish };
}
