import { createRunStateMachine } from "../../src/run-state.js";
import { createRunner } from "../../src/runner.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWorkerTicks(runner) {
  const deadline = performance.now() + 2_000;

  while (runner.inspect().workerTickCount === 0 && performance.now() < deadline) {
    await delay(20);
  }

  assert(runner.inspect().workerTickCount > 0, "The worker did not produce a tick");
}

// A Playwright page can import this module and pass the real T2 CPU probe plus
// its independently established cold-run band. No browser capability is mocked.
export async function runT1BrowserAcceptance({ measureCpu, normalColdRunBand }) {
  assert(typeof measureCpu === "function", "A real browser CPU probe is required");
  assert(Number.isFinite(normalColdRunBand?.minimum), "The cold-run minimum is required");
  assert(Number.isFinite(normalColdRunBand?.maximum), "The cold-run maximum is required");

  const runner = createRunner({ stateMachine: createRunStateMachine() });
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const gl = canvas.getContext("webgl2");
  assert(gl !== null, "WebGL2 is required for this acceptance check");

  const first = runner.start(({ registerWorker, registerWebGlContext, signal }) => {
    const worker = new Worker(new URL("./fixtures/tick-worker.js", import.meta.url), {
      type: "module",
    });
    registerWorker(worker);
    registerWebGlContext(canvas, gl);
    worker.postMessage({ type: "start" });

    return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  });

  await waitForWorkerTicks(runner);
  const cancellation = runner.cancel();
  await cancellation.completion;

  const afterCancel = runner.inspect();
  const tickCount = afterCancel.workerTickCount;
  assert(afterCancel.teardown.started, "Teardown was not exposed as started");
  assert(afterCancel.teardown.complete, "Teardown did not complete");
  assert(afterCancel.webGlContexts[0]?.isContextLost, "The WebGL context was not lost");

  await delay(500);
  assert(
    runner.inspect().workerTickCount === tickCount,
    "The worker tick counter increased during the 500 ms post-cancel window",
  );
  assert((await first.completion).kind === "cancelled", "The first run was not cancelled");

  const next = runner.start((resources) => measureCpu(resources));
  const nextOutcome = await next.completion;
  assert(nextOutcome.kind === "completed", "The run after cancellation did not complete");
  assert(
    nextOutcome.value >= normalColdRunBand.minimum
      && nextOutcome.value <= normalColdRunBand.maximum,
    "The run after cancellation fell outside the normal cold-run band",
  );

  return Object.freeze({
    stoppedTickCount: tickCount,
    contextLost: true,
    nextCpuResult: nextOutcome.value,
  });
}
