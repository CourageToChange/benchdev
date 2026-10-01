export function readPerformanceTimestamp() {
  return performance.now();
}

export function readVisibilityState() {
  return document.visibilityState;
}

export function observeVisibilityStates(onReading) {
  const record = () => onReading(document.visibilityState);

  record();
  document.addEventListener("visibilitychange", record);

  return () => document.removeEventListener("visibilitychange", record);
}

export function readReportedConcurrency() {
  return navigator.hardwareConcurrency ?? null;
}

export function readWebGlRenderer(gl) {
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");

  return {
    maskedRenderer: gl.getParameter(gl.RENDERER),
    unmaskedRenderer: debugInfo === null
      ? null
      : gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
  };
}

export function readWebGlContextLost(gl) {
  return gl.isContextLost();
}

export function observeWebGlContextLoss(canvas, onReading) {
  const record = (event) => onReading(event);

  canvas.addEventListener("webglcontextlost", record);

  return () => canvas.removeEventListener("webglcontextlost", record);
}

export function requestIdleCadenceReading(onReading) {
  return requestAnimationFrame(onReading);
}

export function cancelIdleCadenceReading(requestId) {
  cancelAnimationFrame(requestId);
}
