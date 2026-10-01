let tickTimer = null;

self.addEventListener("message", (event) => {
  if (event.data?.type !== "start" || tickTimer !== null) {
    return;
  }

  tickTimer = setInterval(() => {
    self.postMessage({ type: "tick" });
  }, 10);
});
