import assert from "node:assert/strict";
import test from "node:test";

import { createRunStateMachine } from "../src/run-state.js";
import { createResourceRegistry, createRunner } from "../src/runner.js";
import { evaluateValidity } from "../src/validity.js";

const HASH = "a".repeat(64);

function cadence(intervalMs) {
  return Array.from({ length: 20 }, (_, index) => index * intervalMs);
}

function validityReadings(contextLossEvents) {
  return {
    visibilityStates: ["visible"],
    idleCadence: {
      beforeTimestamps: cadence(16.67),
      afterTimestamps: cadence(16.67),
    },
    webgl: {
      maskedRenderer: "WebKit WebGL",
      unmaskedRenderer: "Example GPU",
      contextLossEvents,
    },
    workloadChecksums: [{ actual: 1, expected: 1 }],
    timer: { samples: [0, 1], shortestWorkUnitMs: 5 },
    parallelism: { reportedConcurrency: 4, measuredConcurrency: 4 },
    phaseEvents: [{ phaseId: "cpu", type: "completed" }],
    wasm: { actualSha256: HASH, expectedSha256: HASH },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeWebGl() {
  const listeners = new Set();
  let contextLost = false;
  const canvas = {
    addEventListener(type, listener) {
      if (type === "webglcontextlost") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "webglcontextlost") listeners.delete(listener);
    },
    loseUnexpectedly() {
      contextLost = true;
      for (const listener of listeners) listener({ type: "webglcontextlost" });
    },
  };
  const gl = {
    getExtension(name) {
      if (name !== "WEBGL_lose_context") return null;
      return {
        loseContext() {
          contextLost = true;
          for (const listener of listeners) listener({ type: "webglcontextlost" });
        },
      };
    },
    isContextLost() {
      return contextLost;
    },
  };

  return { canvas, gl };
}

test("resource teardown is idempotent and never double-disposes", async () => {
  const registry = createResourceRegistry();
  let disposals = 0;
  registry.register(() => {
    disposals += 1;
  });

  const first = registry.teardown();
  const second = registry.teardown();

  assert.deepEqual(await Promise.all([first, second]), [[], []]);
  assert.equal(disposals, 1);
  assert.equal(first, second);
  assert.deepEqual(registry.inspect(), {
    isTearingDown: true,
    teardownComplete: true,
    resourceCount: 0,
  });
});

test("an individually disposed resource still shares idempotent registry teardown", async () => {
  const registry = createResourceRegistry();
  let disposals = 0;
  const registration = registry.register(() => {
    disposals += 1;
  });

  assert.equal(registration.kind, "registered");
  await registration.dispose();
  assert.equal(registry.inspect().resourceCount, 0);
  await registry.teardown();
  await registration.dispose();
  assert.equal(disposals, 1);
});

test("start is rejected while cancellation teardown is still in progress", async () => {
  const release = deferred();
  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const started = runner.start(({ registerDisposable, signal }) => {
    registerDisposable(() => release.promise);
    return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  });

  await Promise.resolve();
  const cancellation = runner.cancel();
  assert.equal(runner.inspect().state, "cancelling");
  assert.deepEqual(runner.start(() => {}), {
    kind: "rejected",
    state: "cancelling",
    event: "start",
    reason: "cancellation-in-progress",
  });

  release.resolve();
  assert.equal((await cancellation.completion).kind, "cancelled");
  assert.equal((await started.completion).kind, "cancelled");
  assert.equal(runner.inspect().state, "idle");
});

test("normal completion, cancellation, and execution error share teardown", async () => {
  for (const scenario of ["complete", "cancel", "fail"]) {
    const runner = createRunner({ stateMachine: createRunStateMachine() });
    let disposals = 0;
    const started = runner.start(({ registerDisposable, signal }) => {
      registerDisposable(() => {
        disposals += 1;
      });

      if (scenario === "fail") throw new Error("mid-run fault");
      if (scenario === "cancel") {
        return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      return 42;
    });

    await Promise.resolve();
    if (scenario === "cancel") runner.cancel();
    const outcome = await started.completion;

    assert.equal(disposals, 1, scenario);
    const expectedKind = {
      complete: "completed",
      cancel: "cancelled",
      fail: "failed",
    }[scenario];
    assert.equal(outcome.kind, expectedKind, scenario);
    assert.equal(runner.inspect().teardown.complete, true, scenario);
    assert.equal(runner.inspect().registeredResourceCount, 0, scenario);
  }
});

test("context loss records teardown state at the event and validity owns the verdict", async () => {
  const genuine = fakeWebGl();
  const genuineRunner = createRunner({ stateMachine: createRunStateMachine() });
  const genuineRun = genuineRunner.start(({ registerWebGlContext }) => {
    registerWebGlContext(genuine.canvas, genuine.gl);
    genuine.canvas.loseUnexpectedly();
  });
  await genuineRun.completion;

  const genuineEvents = genuineRunner.inspect().contextLossEvents;
  assert.deepEqual(genuineEvents, [
    { teardownStarted: false },
    { teardownStarted: true },
  ]);
  assert.deepEqual(
    evaluateValidity(validityReadings(genuineEvents)).reasons,
    ["webgl-context-lost"],
  );

  const deliberate = fakeWebGl();
  const deliberateRunner = createRunner({ stateMachine: createRunStateMachine() });
  const deliberateRun = deliberateRunner.start(({ registerWebGlContext }) => {
    registerWebGlContext(deliberate.canvas, deliberate.gl);
  });
  await deliberateRun.completion;

  const deliberateEvents = deliberateRunner.inspect().contextLossEvents;
  assert.deepEqual(deliberateEvents, [{ teardownStarted: true }]);
  assert.deepEqual(evaluateValidity(validityReadings(deliberateEvents)).reasons, []);
});
