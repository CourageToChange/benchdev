import assert from "node:assert/strict";
import test from "node:test";

import { assertRecordedGpuCapture } from "./browser/t4-acceptance.js";

const WIDTH = 320;
const HEIGHT = 180;

function greyscaleFrame(frameIndex, channel) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);

  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = channel;
    rgba[offset + 1] = channel;
    rgba[offset + 2] = channel;
    rgba[offset + 3] = 255;
  }

  return {
    frameIndex,
    timestampMs: frameIndex * 16.67,
    rgba,
  };
}

function capture(frames) {
  return {
    source: "recorded-compositor-capture",
    width: WIDTH,
    height: HEIGHT,
    frames,
  };
}

test("the frame-by-frame capture assertion accepts only a bounded consecutive recording", () => {
  const boundedFrames = Array.from(
    { length: 60 },
    (_, frameIndex) => greyscaleFrame(frameIndex, frameIndex % 2 === 0 ? 88 : 90),
  );
  const report = assertRecordedGpuCapture(capture(boundedFrames));

  assert.equal(report.frameCount, 60);
  assert.ok(report.maximumObservedDelta > 0);
  assert.ok(report.maximumObservedDelta <= report.constructionBound + 0.004);

  const unsafeFrames = boundedFrames.map((frame) => ({ ...frame }));
  unsafeFrames[30] = greyscaleFrame(30, 255);
  assert.throws(
    () => assertRecordedGpuCapture(capture(unsafeFrames)),
    /exceeded the shader bound/,
  );

  const missingFrame = boundedFrames.map((frame) => ({ ...frame }));
  missingFrame[30].frameIndex = 31;
  assert.throws(
    () => assertRecordedGpuCapture(capture(missingFrame)),
    /omitted or reordered/,
  );
});
