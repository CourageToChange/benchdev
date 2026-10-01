import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunStateMachine,
  RUN_EVENTS,
  RUN_STATES,
  transitionRunState,
} from "../src/run-state.js";

const LEGAL = Object.freeze({
  "idle:start": ["running", "execute", undefined, undefined],
  "running:complete": ["completing", "teardown", undefined, undefined],
  "running:cancel": ["cancelling", "teardown", undefined, undefined],
  "running:fail": ["failing", "teardown", undefined, undefined],
  "completing:teardown-complete": ["idle", "settle", "completed", "value"],
  "cancelling:teardown-complete": ["idle", "settle", "cancelled", null],
  "failing:teardown-complete": ["idle", "settle", "failed", "error"],
});

test("the transition matrix accepts every legal transition and rejects every illegal one", () => {
  for (const state of RUN_STATES) {
    for (const event of RUN_EVENTS) {
      const key = `${state}:${event}`;
      const outcome = transitionRunState(state, event);

      if (Object.hasOwn(LEGAL, key)) {
        assert.deepEqual(
          [
            outcome.kind,
            outcome.to,
            outcome.effect,
            outcome.outcomeKind,
            outcome.payloadKey,
          ],
          ["accepted", ...LEGAL[key]],
          key,
        );
      } else {
        assert.equal(outcome.kind, "rejected", key);
        assert.equal(typeof outcome.reason, "string", key);
        assert.equal(outcome.state, state, key);
      }
    }
  }

  assert.equal(Object.keys(LEGAL).length, 7);
});

test("unknown state and event inputs have defined rejection outcomes", () => {
  assert.deepEqual(transitionRunState("elsewhere", "start"), {
    kind: "rejected",
    state: "elsewhere",
    event: "start",
    reason: "unknown-state",
  });
  assert.deepEqual(transitionRunState("idle", "explode"), {
    kind: "rejected",
    state: "idle",
    event: "explode",
    reason: "unknown-event",
  });
});

test("cancelling is observable state and rejects start with its own reason", () => {
  const machine = createRunStateMachine();

  machine.send("start");
  const cancellation = machine.send("cancel");

  assert.equal(cancellation.to, "cancelling");
  assert.equal(machine.state, "cancelling");
  assert.deepEqual(machine.send("start"), {
    kind: "rejected",
    state: "cancelling",
    event: "start",
    reason: "cancellation-in-progress",
  });
});

test("a rejected transition never mutates state", () => {
  const machine = createRunStateMachine();

  machine.send("complete");
  assert.equal(machine.state, "idle");
});
