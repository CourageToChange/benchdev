import assert from "node:assert/strict";
import test from "node:test";

import { classifyContextLossCapability } from "./browser/t4-acceptance.js";

test("an unavailable context-loss extension is explicitly unverified", () => {
  assert.deepEqual(classifyContextLossCapability(null), {
    acceptanceStatus: "unverified",
    detail: "WEBGL_lose_context is unavailable in this browser environment",
  });
});

test("an available context-loss extension remains runnable", () => {
  const extension = { loseContext() {} };
  assert.deepEqual(classifyContextLossCapability(extension), {
    acceptanceStatus: "available",
    loseContext: extension,
  });
});
