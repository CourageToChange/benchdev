function freezeSnapshot(value) {
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) {
      item.forEach(Object.freeze);
      Object.freeze(item);
    } else if (item !== null && typeof item === "object") {
      Object.freeze(item);
    }
  }

  return Object.freeze(value);
}

export function createResourceRegistry() {
  let entries = [];
  let isTearingDown = false;
  let teardownComplete = false;
  let teardownPromise = null;

  function open() {
    if (entries.length !== 0 || (isTearingDown && !teardownComplete)) {
      throw new Error("Resource registry cannot open before teardown completes");
    }

    isTearingDown = false;
    teardownComplete = false;
    teardownPromise = null;
  }

  function register(dispose) {
    if (typeof dispose !== "function") {
      throw new TypeError("A resource disposer must be a function");
    }

    let disposed = false;
    const entry = {
      async dispose() {
        if (disposed) {
          return;
        }

        disposed = true;
        await dispose();
      },
      isDisposed() {
        return disposed;
      },
    };

    if (isTearingDown) {
      return Object.freeze({
        kind: "rejected",
        reason: "teardown-started",
        disposal: entry.dispose(),
      });
    }

    entries.push(entry);
    return Object.freeze({
      kind: "registered",
      dispose: entry.dispose,
    });
  }

  function teardown() {
    if (teardownPromise !== null) {
      return teardownPromise;
    }

    // This must precede every disposer. WEBGL_lose_context can synchronously
    // notify observers, and validity depends on the value captured at that time.
    isTearingDown = true;
    const pending = entries;
    entries = [];

    teardownPromise = (async () => {
      const errors = [];

      for (const entry of pending) {
        try {
          await entry.dispose();
        } catch (error) {
          errors.push(error);
        }
      }

      teardownComplete = true;
      return Object.freeze(errors);
    })();

    return teardownPromise;
  }

  return Object.freeze({
    open,
    register,
    teardown,
    inspect() {
      return Object.freeze({
        isTearingDown,
        teardownComplete,
        resourceCount: entries.filter((entry) => !entry.isDisposed()).length,
      });
    },
  });
}

export function createRunner({ stateMachine, onTransition = () => {} }) {
  if (stateMachine === null
      || typeof stateMachine !== "object"
      || typeof stateMachine.send !== "function") {
    throw new TypeError("stateMachine must provide send(event)");
  }

  if (typeof onTransition !== "function") {
    throw new TypeError("onTransition must be a function");
  }

  const registry = createResourceRegistry();
  let activeRun = null;
  let workerTickCount = 0;
  let contextLossEvents = [];
  let webGlContexts = [];

  function notify(outcome) {
    onTransition(outcome);
    return outcome;
  }

  function registerWorker(worker, isTick = (event) => event.data?.type === "tick") {
    if (worker === null
        || typeof worker !== "object"
        || typeof worker.addEventListener !== "function"
        || typeof worker.removeEventListener !== "function"
        || typeof worker.terminate !== "function") {
      throw new TypeError("worker must provide event listener and terminate methods");
    }

    if (typeof isTick !== "function") {
      throw new TypeError("isTick must be a function");
    }

    const countTick = (event) => {
      if (isTick(event)) {
        workerTickCount += 1;
      }
    };

    worker.addEventListener("message", countTick);
    return registry.register(() => {
      worker.removeEventListener("message", countTick);
      worker.terminate();
    });
  }

  function registerWebGlContext(canvas, gl) {
    if (canvas === null
        || typeof canvas !== "object"
        || typeof canvas.addEventListener !== "function"
        || typeof canvas.removeEventListener !== "function"
        || gl === null
        || typeof gl !== "object"
        || typeof gl.getExtension !== "function"
        || typeof gl.isContextLost !== "function") {
      throw new TypeError("A canvas and WebGL context are required");
    }

    const loseContext = gl.getExtension("WEBGL_lose_context");

    if (loseContext === null || typeof loseContext.loseContext !== "function") {
      throw new Error("WEBGL_lose_context is required for deterministic teardown");
    }

    const recordContextLoss = () => {
      contextLossEvents.push(Object.freeze({
        teardownStarted: registry.inspect().isTearingDown,
      }));
    };

    canvas.addEventListener("webglcontextlost", recordContextLoss);
    webGlContexts.push(gl);

    return registry.register(() => {
      loseContext.loseContext();
      canvas.removeEventListener("webglcontextlost", recordContextLoss);
    });
  }

  function registerTimer(timerId, cancelTimer = globalThis.clearTimeout) {
    if (typeof cancelTimer !== "function") {
      throw new TypeError("cancelTimer must be a function");
    }

    return registry.register(() => cancelTimer(timerId));
  }

  function registerListener(target, type, listener, options) {
    if (target === null
        || typeof target !== "object"
        || typeof target.addEventListener !== "function"
        || typeof target.removeEventListener !== "function") {
      throw new TypeError("Listener target must provide addEventListener and removeEventListener");
    }

    target.addEventListener(type, listener, options);
    return registry.register(() => target.removeEventListener(type, listener, options));
  }

  function scopeFor(abortController) {
    return Object.freeze({
      signal: abortController.signal,
      registerWorker,
      registerWebGlContext,
      registerTimer,
      registerListener,
      registerDisposable: registry.register,
    });
  }

  async function finish(run, event, payload) {
    if (activeRun !== run || run.finishStarted) {
      return;
    }

    const transition = notify(stateMachine.send(event));

    if (transition.kind === "rejected") {
      return;
    }

    run.finishStarted = true;
    run.payload = payload;
    const teardownErrors = await registry.teardown();
    const settled = notify(stateMachine.send("teardown-complete"));

    activeRun = null;
    const outcome = {
      kind: settled.outcomeKind,
      teardownErrors,
    };

    if (settled.payloadKey !== null) {
      outcome[settled.payloadKey] = run.payload;
    }

    run.resolve(Object.freeze(outcome));
  }

  function start(execute) {
    const transition = notify(stateMachine.send("start"));

    if (transition.kind === "rejected") {
      return transition;
    }

    registry.open();
    contextLossEvents = [];
    webGlContexts = [];

    let resolve;
    const completion = new Promise((settle) => {
      resolve = settle;
    });
    const abortController = new AbortController();
    const run = {
      completion,
      resolve,
      finishStarted: false,
      payload: undefined,
    };

    activeRun = run;
    registry.register(() => abortController.abort());

    Promise.resolve()
      .then(() => execute(scopeFor(abortController)))
      .then(
        (value) => finish(run, "complete", value),
        (error) => finish(run, "fail", error),
      );

    return Object.freeze({
      kind: "started",
      transition,
      completion,
    });
  }

  function cancel() {
    if (activeRun === null) {
      return notify(stateMachine.send("cancel"));
    }

    const run = activeRun;
    void finish(run, "cancel");
    return Object.freeze({
      kind: "cancel-requested",
      completion: run.completion,
    });
  }

  return Object.freeze({
    start,
    cancel,
    inspect() {
      const teardown = registry.inspect();
      return freezeSnapshot({
        state: stateMachine.state,
        workerTickCount,
        teardown: {
          started: teardown.isTearingDown,
          complete: teardown.teardownComplete,
        },
        registeredResourceCount: teardown.resourceCount,
        contextLossEvents: [...contextLossEvents],
        webGlContexts: webGlContexts.map((gl) => ({ isContextLost: gl.isContextLost() })),
      });
    },
  });
}
