import assert from "node:assert/strict";
import test from "node:test";
import { createInvocationCleanup } from "../src/lifecycle.ts";

test("invocation cleanup performs every effect exactly once", () => {
  const calls = { abort: 0, close: 0, removeListeners: 0 };
  const cleanup = createInvocationCleanup({
    abort: () => { calls.abort += 1; },
    close: () => { calls.close += 1; },
    removeListeners: () => { calls.removeListeners += 1; },
  });

  cleanup.abort();
  cleanup.abort();
  cleanup.finish();
  cleanup.finish();
  cleanup.close();
  cleanup.removeListeners();

  assert.deepEqual(calls, { abort: 1, close: 1, removeListeners: 1 });
});

test("one failing cleanup effect does not skip the others", () => {
  const calls = [];
  const cleanup = createInvocationCleanup({
    abort: () => {
      calls.push("abort");
      throw new Error("abort failed");
    },
    close: () => {
      calls.push("close");
      throw new Error("close failed");
    },
    removeListeners: () => { calls.push("removeListeners"); },
  });

  cleanup.finish();
  cleanup.finish();

  assert.deepEqual(calls, ["abort", "close", "removeListeners"]);
});
