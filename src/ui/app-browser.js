import { BASELINES } from "../baselines.js";
import {
  BENCHMARK_PHASES,
  createBenchmarkController,
} from "../benchmark-browser.js";
import { createComparisonTableState, readCorpus } from "../corpus.js";
import { BENCHMARK_PROTOCOL_VERSION } from "../result.js";
import { SCORE_FACTORS, SCORING_VERSION } from "../scoring.js";
import { detectPreviewMode } from "../workloads/gpu-browser.js";
import {
  browserIdentity,
  copyForReason,
  createConsentSession,
  formatElapsed,
  formatMeasuredValue,
  formatScore,
  MEASUREMENT_LABELS,
  referenceLandmark,
  RUN_LENGTHS,
  RUN_STOPPED_COPY,
  scoreAxisPosition,
} from "./model.js";
import { SUSTAINED_LOAD_DURATION_MS } from "../sustained.js";

const app = document.querySelector("#app");
const screenRoot = document.querySelector("#screen");
const session = createConsentSession();
const identity = browserIdentity({
  userAgentData: navigator.userAgentData ?? null,
  userAgent: navigator.userAgent,
});
// 🔴 ARCH-12, Gate 4: this ran bare at module scope, and `referenceLandmark` throws when the
// baseline set has no entry for the current protocol. The throw stopped module evaluation, so
// `renderIdle()` at the bottom never ran and the visitor got the static heading above an empty
// div, with NO error and NO message. On a product whose unscored screen was designed this
// carefully, the one failure that produces literal silence deserved better than nothing.
//
// It is also the exact failure a protocol bump without a matching baseline would cause.
let landmark = null;
let startupFailure = null;
try {
  landmark = referenceLandmark(BASELINES, BENCHMARK_PROTOCOL_VERSION);
} catch (error) {
  startupFailure = error instanceof Error ? error.message : String(error);
}

let controller = null;
let runningStartedAt = null;
let progressTimer = null;
let traceTimer = null;
let activeRunLength = "quick";

// T9: start one same-origin static read per page load. The rejection branch is attached now so a
// network or schema failure cannot become an unhandled rejection while the benchmark is running.
const corpusLoad = fetch(new URL("../../corpus.json", import.meta.url))
  .then((response) => {
    if (!response.ok) {
      throw new Error(`Corpus request failed with status ${response.status}`);
    }

    return response.json();
  })
  .then((payload) => readCorpus(payload, {
    protocolVersion: BENCHMARK_PROTOCOL_VERSION,
    scoringVersion: SCORING_VERSION,
  }))
  .then(
    (corpus) => ({ kind: "loaded", corpus }),
    () => ({ kind: "failed" }),
  );

function element(tagName, className = null, text = null) {
  const node = document.createElement(tagName);

  if (className !== null) {
    node.className = className;
  }

  if (text !== null) {
    node.textContent = text;
  }

  return node;
}

function append(parent, ...children) {
  parent.append(...children.filter((child) => child !== null));
  return parent;
}

// A live region only announces reliably when it EXISTS before its text changes, which is why the
// narration node is created empty and written to later. Same treatment here.
function announce(node) {
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  return node;
}

function clearScreen(screen) {
  while (screenRoot.firstChild !== null) {
    screenRoot.firstChild.remove();
  }
  // ⚠️ The current screen is recorded on the root so it can be OBSERVED from outside.
  // Without it, nothing can assert which of the five states is showing, and this project's own
  // first lesson is that a gate which cannot see the artifact is not a gate. It is a test hook,
  // not behaviour: nothing in the app reads it back.
  if (screen) screenRoot.dataset.screen = screen;
}

function setResultWidth(enabled) {
  app.classList.toggle("result-width", enabled);
}

function heading(text, { focus = false } = {}) {
  const node = element("h2", null, text);

  if (focus) {
    node.tabIndex = -1;
    requestAnimationFrame(() => node.focus());
  }

  return node;
}

function createAxis(score = null) {
  const axis = element("section", "measurement-axis");
  axis.setAttribute("aria-label", "BenchDev measurement axis");
  const line = element("div", "axis-line");
  line.setAttribute("aria-hidden", "true");
  const reference = element("div", "axis-reference");
  reference.setAttribute("aria-hidden", "true");
  const label = element("p", "axis-label", landmark);
  append(axis, line, reference, label);

  if (score !== null) {
    const position = scoreAxisPosition(score);
    const marker = element("div", "axis-marker");
    const scoreLabel = element("p", "axis-score-label", formatScore(score));
    axis.classList.add("has-score");
    marker.style.left = `${position}%`;
    marker.setAttribute("aria-hidden", "true");
    scoreLabel.style.left = `${position}%`;

    if (position < 25) {
      scoreLabel.classList.add("align-left");
    } else if (position > 75) {
      scoreLabel.classList.add("align-right");
    } else {
      scoreLabel.classList.add("align-centre");
    }

    append(axis, scoreLabel, marker);
  }

  return axis;
}

function createButton(text, className, onClick) {
  const button = element("button", className, text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function createRunLengthControl() {
  const fieldset = element("fieldset");
  const legend = element("legend", null, "Choose the test length");
  const choices = element("div", "segmented-control");

  for (const runLength of Object.values(RUN_LENGTHS)) {
    const input = element("input");
    input.type = "radio";
    input.name = "run-length";
    input.id = `run-length-${runLength.id}`;
    input.value = runLength.id;
    input.checked = session.runLength === runLength.id;
    input.addEventListener("change", () => {
      if (input.checked) {
        session.select(runLength.id);
      }
    });
    const label = element(
      "label",
      null,
      `${runLength.label}: ${runLength.durationLabel}`,
    );
    label.htmlFor = input.id;
    append(choices, input, label);
  }

  return append(fieldset, legend, choices);
}

function createRefusalDisclosure() {
  const details = element("details");
  const summary = element("summary", null, "What BenchDev does not keep");
  const text = "BenchDev creates no account, login, cookie, persistent identifier or client-generated identifier. Its server keeps no request log, so it does not retain an IP address, precise timestamp, language, timezone or full user-agent string. No analytics or error report is sent. Cloudflare, which carries the traffic to this site, processes IP addresses under its own privacy policy.";
  return append(details, summary, element("p", null, text));
}

function beginFromIdle() {
  const next = session.requestRun();

  if (next === "consent") {
    renderConsent();
  } else {
    startRun();
  }
}

// UX-15, Gate 3: focus landed on <body> after idle->consent, consent->running and Escape-cancel.
// The correct pattern was already implemented on the two terminal screens and simply not applied
// to the other three, so a keyboard user had to Tab from the top of the document each time.
function renderIdle(statusText = null) {
  stopLiveUi();
  clearScreen("idle");
  setResultWidth(false);
  const section = element("section");
  append(
    section,
    element("p", "lede", "A local CPU and GPU benchmark. One score, with every measured part shown."),
    createAxis(),
    // UX-10, Gate 3: this text ("The run was cancelled") was announced to NOBODY. It is the only
    // evidence a keyboard user gets that Escape worked, and Escape is the keyboard cancel path, so
    // the group that most needs the message was the group not receiving it.
    statusText === null ? null : announce(element("p", "notice-block", statusText)),
    createRunLengthControl(),
    createButton("Run device benchmark", "button-primary", beginFromIdle),
    createRefusalDisclosure(),
  );
  screenRoot.append(section);
}

function consentCopy() {
  // ⚠️ THESE NUMBERS ARE DERIVED, and they were not. The button label was fixed to compute its
  // duration from the protocol and this prose beside it still said "20 seconds" and "68 seconds",
  // so the same screen carried the corrected number and the stale one at the same time. A duration
  // written by hand goes stale wherever it appears, and fixing the first one you find is not
  // fixing it.
  const seconds = RUN_LENGTHS[session.runLength].seconds;
  const sustainedSeconds = Math.round(SUSTAINED_LOAD_DURATION_MS / 1000);

  if (session.runLength === "full") {
    return `This test keeps the processor and graphics hardware busy for about ${seconds} seconds, including ${sustainedSeconds} seconds of sustained work. Other work may feel slower. Keep this tab in front. The run can be cancelled at any time.`;
  }

  return `This test keeps the processor and graphics hardware busy for about ${seconds} seconds. Other work may feel slower. Keep this tab in front. The run can be cancelled at any time.`;
}

function renderConsent() {
  clearScreen("consent");
  setResultWidth(false);
  const section = element("section");
  const block = element("div", "consent-block");
  const buttons = element("div", "button-row");
  const chosen = RUN_LENGTHS[session.runLength];
  append(
    block,
    heading("Before the test starts", { focus: true }),
    element("p", null, consentCopy()),
    element("p", "section-label", `${chosen.label} test / ${chosen.durationLabel}`),
    append(
      buttons,
      createButton(`Start the ${chosen.seconds}-second test`, "button-primary", () => {
        session.grantConsent();
        startRun();
      }),
      createButton("Back", "button-secondary", () => {
        session.back();
        renderIdle();
      }),
    ),
  );
  append(section, createAxis(), block);
  screenRoot.append(section);
}

function createTrace() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.classList.add("live-trace");
  svg.setAttribute("viewBox", "0 0 600 64");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "M0 32 L600 32");
  svg.append(path);
  return { svg, path };
}

function updateTrace(path) {
  const elapsed = performance.now() - runningStartedAt;
  const points = [];

  for (let index = 0; index <= 30; index += 1) {
    const x = index * 20;
    const y = 32 + Math.sin(elapsed / 700 + index * 0.63) * 9
      + Math.sin(elapsed / 1_900 + index * 0.21) * 5;
    points.push(`${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }

  path.setAttribute("d", points.join(" "));
}

function stopLiveUi() {
  if (progressTimer !== null) {
    clearInterval(progressTimer);
    progressTimer = null;
  }

  if (traceTimer !== null) {
    clearInterval(traceTimer);
    traceTimer = null;
  }
}

function renderRunning() {
  clearScreen("running");
  setResultWidth(false);
  const section = element("section");
  const runningHeader = element("div", "running-header");
  const elapsed = element("p", "elapsed", "Elapsed 00:00");
  const progress = element("progress");
  const layout = element("div", "running-layout");
  const phaseColumn = element("div");
  const previewColumn = element("div");
  const phaseList = element("ol", "phase-list");
  const narration = element("p", "narration", "Preparing the local measurement environment.");
  const previewStack = element("div", "preview-stack");
  const previewCanvas = element("canvas", "gpu-preview");
  const sustainedCanvas = element("canvas", "gpu-preview");
  const trace = createTrace();
  const runningAxis = createAxis();
  const cancelRow = element("div", "cancel-row");
  const cancelButton = createButton("Cancel test", "button-secondary", () => cancelRun(cancelButton, narration));

  progress.max = 100;
  progress.value = 0;
  progress.setAttribute("aria-label", "Benchmark progress");
  previewCanvas.width = 320;
  previewCanvas.height = 180;
  previewCanvas.setAttribute("aria-hidden", "true");
  sustainedCanvas.width = 320;
  sustainedCanvas.height = 180;
  sustainedCanvas.hidden = true;
  sustainedCanvas.setAttribute("aria-hidden", "true");
  narration.setAttribute("aria-live", "polite");
  narration.setAttribute("role", "status");
  runningAxis.classList.add("running-axis");
  runningAxis.append(trace.svg);

  for (const phase of BENCHMARK_PHASES[activeRunLength]) {
    const item = element("li", null, phase.label);
    item.dataset.phaseId = phase.id;
    phaseList.append(item);
  }

  append(runningHeader, heading("Test running", { focus: true }), elapsed);
  append(phaseColumn, phaseList, narration, append(cancelRow, cancelButton));
  append(previewStack, previewCanvas, sustainedCanvas);
  append(previewColumn, previewStack);
  append(layout, phaseColumn, previewColumn);
  append(section, runningHeader, progress, runningAxis, layout);
  screenRoot.append(section);

  return {
    elapsed,
    progress,
    phaseList,
    narration,
    previewCanvas,
    sustainedCanvas,
    tracePath: trace.path,
  };
}

function showPhase(view, phase) {
  const items = [...view.phaseList.children];

  items.forEach((item, index) => {
    // UX-14, Gate 3: done and not-started differed by TEXT COLOUR ALONE at 1.52:1, with an
    // identical dash and no ARIA, so the running screen's main progress narrative was invisible to
    // anyone not discriminating that contrast, and absent entirely for screen readers.
    const isComplete = index < phase.index;
    item.classList.toggle("complete", isComplete);
    let doneMark = item.querySelector(".visually-hidden");
    if (isComplete && doneMark === null) {
      doneMark = element("span", "visually-hidden", " done");
      item.append(doneMark);
    } else if (!isComplete && doneMark !== null) {
      doneMark.remove();
    }
    item.classList.toggle("current", index === phase.index);
    if (index === phase.index) {
      item.setAttribute("aria-current", "step");
    } else {
      item.removeAttribute("aria-current");
    }
  });
  view.narration.textContent = phase.narration;

  if (phase.id === "sustained" || phase.id === "recovery") {
    view.previewCanvas.hidden = true;
    view.sustainedCanvas.hidden = false;
  }
}

function cancelRun(button, narration) {
  button.disabled = true;
  narration.textContent = "Cancelling the current run.";
  controller?.cancel();
}

function startRun() {
  activeRunLength = session.runLength;
  runningStartedAt = performance.now();
  const view = renderRunning();
  const totalMs = RUN_LENGTHS[activeRunLength].seconds * 1_000;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  controller = createBenchmarkController({
    onPhase: (phase) => showPhase(view, phase),
  });
  progressTimer = setInterval(() => {
    const elapsedMs = performance.now() - runningStartedAt;
    view.elapsed.textContent = `Elapsed ${formatElapsed(elapsedMs)}`;
    view.progress.value = Math.min(98, elapsedMs / totalMs * 100);
  }, 250);
  traceTimer = setInterval(
    () => updateTrace(view.tracePath),
    reducedMotion ? 1_000 : 120,
  );

  const started = controller.start({
    runLength: activeRunLength,
    previewCanvas: view.previewCanvas,
    sustainedCanvas: view.sustainedCanvas,
    previewMode: detectPreviewMode(),
  });

  if (started.kind !== "started") {
    stopLiveUi();
    session.finish("failed");
    renderUnscored({
      failure: RUN_STOPPED_COPY,
      diagnostics: { outcome: started },
    });
    return;
  }

  void started.completion.then((outcome) => {
    stopLiveUi();

    if (outcome.kind === "cancelled") {
      session.back();
      renderIdle("The run was cancelled. No result was saved.");
      return;
    }

    if (outcome.kind === "failed") {
      session.finish("failed");
      renderUnscored({
        failure: RUN_STOPPED_COPY,
        diagnostics: {
          outcome: "run-stopped",
          message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          teardownMessages: outcome.teardownErrors.map((error) => String(error)),
        },
      });
      return;
    }

    const report = outcome.value;
    session.finish(report.result.kind);

    if (report.result.kind === "scored") {
      renderResult(report);
    } else {
      renderUnscored(report);
    }
  });
}

// ARCH-11, Gate 4: this used to print "CPU + GPU" from a single test for the GPU sub-score, so a
// result missing CPU JS rendered identically to a complete one. The scoring rule makes composition part of
// the label and `composition.label` already holds the true one, so deriving a second, lossier
// version of it in the view was both duplication and a quiet inaccuracy.
function createComposition(result) {
  const composition = element("p", "composition");
  const present = new Set(result.subScores.map(({ id }) => id));

  SCORE_FACTORS.forEach((factor, index) => {
    if (index > 0) composition.append(document.createTextNode(" + "));
    composition.append(present.has(factor.id)
      ? document.createTextNode(factor.compositionLabel)
      : element("s", null, factor.compositionLabel));
  });

  return composition;
}

function createIdentityStamp(report) {
  const reference = BASELINES.entries.find(({ protocolVersion }) => (
    protocolVersion === report.result.protocolVersion
  )).referenceDevice;
  const composition = report.scoreDetails.composition.label;
  const text = `${composition} / ${identity.name} ${identity.version} / baseline ${report.result.baselineVersion}: ${reference.model}, ${reference.measuredMonth} / protocol ${report.result.protocolVersion}`;
  return element("p", "identity-stamp", text);
}

function createNotesRow(report) {
  const count = report.validity.noteDetails.length;
  const text = count === 0
    ? "No notes on this result"
    : `${count} ${count === 1 ? "note" : "notes"} on this result: ${report.validity.noteDetails.map(({ text: note }) => note).join(" ")}`;
  return element("p", "notes-row", text);
}

function createSubscoreTable(result) {
  const table = element("table", "subscore-table");
  const caption = element("caption", "visually-hidden", "BenchDev sub-scores");
  const head = element("thead");
  const headRow = element("tr");
  const body = element("tbody");
  append(headRow, element("th", null, "Measured part"), element("th", null, "Sub-score"));
  headRow.children[0].scope = "col";
  headRow.children[1].scope = "col";
  head.append(headRow);

  for (const subScore of result.subScores) {
    const row = element("tr");
    append(
      row,
      element("td", null, MEASUREMENT_LABELS[subScore.id] ?? subScore.id),
      element("td", null, `${formatMeasuredValue(subScore.value)} ${subScore.unit}`),
    );
    body.append(row);
  }

  return append(table, caption, head, body);
}

// ARCH-06, Gate 4: `omittedSubScores` was computed by the scoring and dropped one call later, so
// the result screen showed "CPU parallel 1,054 work units/second" under Raw measured values and no
// CPU parallel row under Sub-scores, with nothing connecting the two. The scoring gives every
// partial-failure path a defined answer; the answer existed and nobody rendered it.
function createOmissionNote(scoreDetails) {
  // ⚠️ Read from `scoreDetails`, NOT from `result`. The RunResult contract is deliberately a
  // fixed field set that strips measurements to {id, value, unit}, so carrying this on it would be
  // a schema change. The scoring's own return value already reaches the view, and reading the
  // contract the scoring produced is exactly what the scoring intends.
  const omitted = scoreDetails?.omittedSubScores ?? [];
  if (omitted.length === 0) return null;

  const reasons = {
    "baseline-missing": "measured, but not scored: there is no reference value for it yet",
    "measurement-missing": "not measured on this run",
  };
  const list = element("ul", "omission-list");
  for (const { id, reason } of omitted) {
    list.append(element("li", null,
      `${MEASUREMENT_LABELS[id] ?? id} ${reasons[reason] ?? reason}.`));
  }
  return append(element("div", "omission-note"),
    element("p", "section-label", "Left out of the score"), list);
}

function createRawValues(result) {
  const details = element("details");
  const summary = element("summary", null, "Raw measured values");
  const table = element("table", "raw-table");
  const caption = element("caption", "visually-hidden", "Raw benchmark measurements");
  const body = element("tbody");

  for (const measured of result.measurements) {
    const row = element("tr");
    append(
      row,
      element("th", null, MEASUREMENT_LABELS[measured.id] ?? measured.id),
      element("td", null, `${formatMeasuredValue(measured.value)} ${measured.unit}`),
    );
    row.children[0].scope = "row";
    body.append(row);
  }

  append(table, caption, body);
  return append(details, summary, table);
}

function createSustainedBlock(report) {
  if (activeRunLength !== "full") {
    return null;
  }

  const block = element("section", "sustained-block");
  const measured = report.sustained;

  if (measured?.kind !== "measured") {
    return append(
      block,
      element("h3", null, "Sustained measurement unavailable"),
      element("p", null, "The complete sustained evidence set was not available for this run."),
    );
  }

  const decline = measured.decline;
  const recovery = measured.recoveryProbe;
  // UX-12/UX-13, Gate 3: the verdict was two-valued on a hard `ratio >= 1` boundary, so a 0.35%
  // difference read as "Slowed under load" on a run whose own noise was 1.19%. The classification
  // now lives in the decision module and has a third value for a change inside the measurement's
  // own noise. The view only reads it.
  // ARCH-05, Gate 4: this used to fall back to `ratio >= 1` when `change` was absent, which is a
  // verbatim copy of the two-valued boundary Gate 3 caught calling a 0.35% difference a slowdown.
  // The module can no longer produce that verdict and the view could. If `change` is missing the
  // run is malformed, and the honest response is to say so rather than guess a verdict.
  const change = decline.change;
  const verdictText = {
    "held-steady": "Held steady",
    "within-noise": "No measurable change",
    slowed: "Slowed under load",
  }[change];
  const sentence = change === "held-steady"
    ? `The closing five seconds held ${formatMeasuredValue(decline.sustainedToPeakRatio * 100)} percent of the opening work rate.`
    : change === "within-noise"
      ? `The closing five seconds differed by ${formatMeasuredValue(decline.declinePercent)} percent from the opening five seconds, which is inside this run's own measurement variation. Too small to call a change.`
      : `The closing five seconds completed ${formatMeasuredValue(decline.declinePercent)} percent less work at the same scene complexity than the opening five seconds.`;
  const recoverySentence = recovery.status === "recovered"
    ? "The opening processor test returned toward its earlier rate after the idle interval."
    : "The opening processor test did not return toward its earlier rate after the idle interval. The cause is unattributed.";
  return append(
    block,
    element("p", "section-label", "Sustained work"),
    element("p", `sustained-verdict verdict-${change}`, verdictText),
    element("p", null, sentence),
    element("p", null, recoverySentence),
  );
}

function diagnosticEnvelope(diagnostics) {
  return {
    ...diagnostics,
    detected: {
      browser: identity,
    },
  };
}

function createDiagnosticControls(diagnostics) {
  const wrapper = element("div");
  const details = element("details");
  const summary = element("summary", null, "Diagnostic JSON");
  const pre = element("pre", "diagnostic-json");
  const json = JSON.stringify(diagnosticEnvelope(diagnostics), null, 2);
  // UX-10, Gate 3: both the copy-success and the clipboard-failure messages were silent.
  const status = announce(element("p", "copy-status"));
  pre.textContent = json;
  append(details, summary, pre);
  const copyButton = createButton("Copy diagnostic JSON", "button-secondary", async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") {
        throw new Error("Clipboard API unavailable");
      }

      await navigator.clipboard.writeText(json);
      status.textContent = "Diagnostic JSON copied.";
    } catch {
      let fallback = wrapper.querySelector("textarea");

      if (fallback === null) {
        // UX-11, Gate 3: this had NO accessible name, the single axe violation in the whole app,
        // rated critical, and it lives in a conditional state a five-state sweep never enters. A
        // screen-reader user was focused into an unnamed edit box holding 2,496 characters of JSON.
        fallback = element("textarea", "diagnostic-fallback");
        fallback.setAttribute("aria-label", "Diagnostic JSON, ready to copy");
        fallback.readOnly = true;
        fallback.value = json;
        wrapper.append(fallback);
      }

      status.textContent = "Clipboard access was unavailable. The diagnostic JSON is selected below.";
      fallback.focus();
      fallback.select();
    }
  });
  return append(wrapper, details, copyButton, status);
}

function rerunControls() {
  const row = element("div", "button-row");
  return append(
    row,
    createButton(`Run ${RUN_LENGTHS[activeRunLength].label} again`, "button-primary", () => {
      session.requestRun();
      startRun();
    }),
    createButton("Change test length", "button-secondary", () => {
      session.back();
      renderIdle();
    }),
  );
}

function comparisonMeasurement(measurement) {
  if (measurement.value === null) return "Not available";
  return `${formatMeasuredValue(measurement.value)} ${measurement.unit}`;
}

function selectedRenderer(renderer) {
  if (renderer === null || renderer === undefined) return "Not available";
  if (typeof renderer === "string") return renderer;
  return renderer.unmaskedRenderer ?? renderer.maskedRenderer ?? "Not available";
}

function appendDetectedFact(list, term, description) {
  append(list, element("dt", null, term), element("dd", null, description));
}

function createCorpusDetectedFacts(detected) {
  const list = element("dl", "detected-facts");
  appendDetectedFact(
    list,
    "Browser",
    `${detected.browser.name} ${detected.browser.majorVersion}`,
  );
  appendDetectedFact(list, "System", detected.osFamily);
  appendDetectedFact(list, "Graphics", selectedRenderer(detected.gpuRenderer));
  appendDetectedFact(
    list,
    "Reported processors",
    comparisonMeasurement(detected.reportedConcurrency),
  );
  appendDetectedFact(
    list,
    "Measured parallelism",
    comparisonMeasurement(detected.measuredParallelism),
  );
  appendDetectedFact(
    list,
    "Pixel ratio",
    comparisonMeasurement(detected.devicePixelRatio),
  );
  return list;
}

function createCurrentDetectedFacts(report) {
  const environment = report.diagnostics.environment;
  const list = element("dl", "detected-facts");
  appendDetectedFact(list, "Browser", `${identity.name} ${identity.version}`);
  appendDetectedFact(list, "Graphics", selectedRenderer(environment.gpuRenderer));
  appendDetectedFact(
    list,
    "Reported processors",
    environment.reportedConcurrency === null
      ? "Not available"
      : `${formatMeasuredValue(environment.reportedConcurrency)} logical processors`,
  );
  appendDetectedFact(
    list,
    "Measured parallelism",
    `${formatMeasuredValue(environment.measuredConcurrency)} workers`,
  );
  appendDetectedFact(
    list,
    "Pixel ratio",
    `${formatMeasuredValue(window.devicePixelRatio)} ratio`,
  );
  return list;
}

function createComparisonDeviceCell(row) {
  const cell = element("th", "comparison-device");
  cell.scope = "row";

  if (row.kind === "current") {
    return append(
      cell,
      element("span", "comparison-label-kind current-run-label", "Current run"),
      element("p", "comparison-device-name", "Your device"),
      element("p", "comparison-device-meta", `Baseline ${row.baselineVersion} / protocol ${row.protocolVersion}`),
    );
  }

  if (row.label.kind === "claimed") {
    append(
      cell,
      element("span", "comparison-label-kind claimed-label", "Claimed label"),
      element("p", "comparison-device-name", row.label.value),
    );
  } else {
    append(
      cell,
      element("span", "comparison-label-kind unlabelled-label", "No claimed label"),
    );
  }

  return append(
    cell,
    element("p", "comparison-device-meta", `Captured ${row.capturedMonth} / baseline ${row.baselineVersion} / protocol ${row.protocolVersion}`),
  );
}

function comparisonScoreCell(measurement) {
  return element(
    "td",
    "comparison-score",
    measurement === undefined
      ? "Not scored"
      : `${formatMeasuredValue(measurement.value)} ${measurement.unit}`,
  );
}

function createComparisonRow(row, report = null) {
  const tableRow = element("tr", row.kind === "current" ? "current-comparison-row" : null);
  const subScores = new Map(row.subScores.map((subScore) => [subScore.id, subScore]));
  append(
    tableRow,
    createComparisonDeviceCell(row),
    report === null
      ? append(element("td", "comparison-detected"), createCorpusDetectedFacts(row.detected))
      : append(element("td", "comparison-detected"), createCurrentDetectedFacts(report)),
    comparisonScoreCell(row.score),
    ...SCORE_FACTORS.map(({ id }) => comparisonScoreCell(subScores.get(id))),
  );
  return tableRow;
}

function createComparisonTable(state, report) {
  const wrapper = element("div", "comparison-table-wrap");
  const table = element("table", "comparison-table");
  const caption = element("caption", "visually-hidden", "Named device score comparison");
  const head = element("thead");
  const headRow = element("tr");
  const body = element("tbody");
  const current = {
    kind: "current",
    score: report.result.score,
    subScores: report.result.subScores,
    baselineVersion: report.result.baselineVersion,
    protocolVersion: report.result.protocolVersion,
  };

  append(
    headRow,
    element("th", null, "Device label"),
    element("th", null, "Detected details"),
    element("th", null, "Score"),
    ...SCORE_FACTORS.map(({ id }) => element("th", null, MEASUREMENT_LABELS[id] ?? id)),
  );
  for (const column of headRow.children) column.scope = "col";
  head.append(headRow);
  body.append(createComparisonRow(current, report));
  for (const row of state.rows) body.append(createComparisonRow(row));
  append(table, caption, head, body);
  return append(wrapper, table);
}

function createComparisonSection(report) {
  const section = element("section", "comparison-section");
  const content = announce(element("p", "comparison-status", "Loading comparison devices."));
  append(
    section,
    element("h3", null, "Named device comparison"),
    element("p", "comparison-intro", "Claimed labels are human supplied. Detected details are browser observations."),
    content,
  );

  void corpusLoad.then((loaded) => {
    if (!section.isConnected) return;

    if (loaded.kind === "failed") {
      content.textContent = "Comparison devices could not be loaded. Your score is unchanged.";
      return;
    }

    const state = createComparisonTableState(loaded.corpus.entries);
    if (state.kind === "empty") {
      content.textContent = state.message;
      return;
    }

    content.removeAttribute("role");
    content.removeAttribute("aria-live");
    content.replaceWith(createComparisonTable(state, report));
  });

  return section;
}

function renderResult(report) {
  clearScreen("result");
  setResultWidth(true);
  const section = element("section");
  const resultGrid = element("div", "result-grid");
  const primary = element("div");
  const resultDetails = element("div", "result-details");
  const result = report.result;
  append(
    primary,
    heading("Measured score", { focus: true }),
    createAxis(result.score.value),
    element("p", "score-unit", result.score.unit),
    createComposition(result),
    createIdentityStamp(report),
    createNotesRow(report),
  );
  append(
    resultDetails,
    element("h3", null, "Sub-scores"),
    createSubscoreTable(result),
    createOmissionNote(report.scoreDetails),
    createSustainedBlock(report),
    createRawValues(result),
    createDiagnosticControls(report.diagnostics),
  );
  append(resultGrid, primary, resultDetails);
  append(section, resultGrid, createComparisonSection(report), rerunControls());
  screenRoot.append(section);
}

function reasonItem(copy) {
  const item = element("li");
  return append(
    item,
    element("h3", null, copy.headline),
    element("p", "reason-mechanism", copy.mechanism),
    element("p", "reason-action", copy.action),
  );
}

function renderUnscored(report) {
  clearScreen("unscored");
  setResultWidth(false);
  const section = element("section");
  const reasons = element("ul", "reason-list");
  const reasonIds = report.result?.reasons ?? [];

  if (report.failure !== undefined) {
    reasons.append(reasonItem(report.failure));
  } else {
    for (const reasonId of reasonIds) {
      reasons.append(reasonItem(copyForReason(reasonId)));
    }
  }

  append(
    section,
    heading("No score was produced", { focus: true }),
    element("p", "lede", "The recorded conditions do not support a number. The evidence is shown below so the next run can be different."),
    createAxis(),
    reasons,
    createDiagnosticControls(report.diagnostics),
    rerunControls(),
  );
  screenRoot.append(section);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && session.screen === "running") {
    event.preventDefault();
    controller?.cancel();
  }
});

if (startupFailure === null) {
  renderIdle();
} else {
  // Say what happened, in the same voice as the unscored screen: no blame, no jargon, and the
  // mechanism stated so somebody can act on it.
  clearScreen("startup-failed");
  const section = element("section", "screen-block");
  append(
    section,
    element("h2", null, "This build cannot show a score"),
    element("p", null, "Its reference measurements do not match the version of the benchmark it "
      + "was built with, so any number it produced would be compared against nothing."),
    element("p", "detail-line", startupFailure),
  );
  screenRoot.append(section);
}
