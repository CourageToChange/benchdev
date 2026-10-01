export const RUN_STATES = Object.freeze([
  "idle",
  "running",
  "completing",
  "cancelling",
  "failing",
]);

export const RUN_EVENTS = Object.freeze([
  "start",
  "complete",
  "cancel",
  "fail",
  "teardown-complete",
]);

const TRANSITIONS = Object.freeze({
  idle: Object.freeze({
    start: Object.freeze({ to: "running", effect: "execute" }),
  }),
  running: Object.freeze({
    complete: Object.freeze({ to: "completing", effect: "teardown" }),
    cancel: Object.freeze({ to: "cancelling", effect: "teardown" }),
    fail: Object.freeze({ to: "failing", effect: "teardown" }),
  }),
  completing: Object.freeze({
    "teardown-complete": Object.freeze({
      to: "idle",
      effect: "settle",
      outcomeKind: "completed",
      payloadKey: "value",
    }),
  }),
  cancelling: Object.freeze({
    "teardown-complete": Object.freeze({
      to: "idle",
      effect: "settle",
      outcomeKind: "cancelled",
      payloadKey: null,
    }),
  }),
  failing: Object.freeze({
    "teardown-complete": Object.freeze({
      to: "idle",
      effect: "settle",
      outcomeKind: "failed",
      payloadKey: "error",
    }),
  }),
});

function rejectionReason(state, event) {
  if (!RUN_EVENTS.includes(event)) {
    return "unknown-event";
  }

  if (event === "start") {
    return state === "cancelling" ? "cancellation-in-progress" : "run-in-progress";
  }

  return "event-not-allowed-in-state";
}

export function transitionRunState(state, event) {
  if (!RUN_STATES.includes(state)) {
    return Object.freeze({
      kind: "rejected",
      state,
      event,
      reason: "unknown-state",
    });
  }

  const transition = TRANSITIONS[state][event];

  if (transition === undefined) {
    return Object.freeze({
      kind: "rejected",
      state,
      event,
      reason: rejectionReason(state, event),
    });
  }

  const outcome = {
    kind: "accepted",
    from: state,
    to: transition.to,
    event,
    effect: transition.effect,
  };

  if (transition.outcomeKind !== undefined) {
    outcome.outcomeKind = transition.outcomeKind;
    outcome.payloadKey = transition.payloadKey;
  }

  return Object.freeze(outcome);
}

export function createRunStateMachine() {
  let state = "idle";

  return Object.freeze({
    get state() {
      return state;
    },

    send(event) {
      const outcome = transitionRunState(state, event);

      if (outcome.kind === "accepted") {
        state = outcome.to;
      }

      return outcome;
    },
  });
}
