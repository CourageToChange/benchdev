# T4 recorded-capture verification

This acceptance check remains pending until it is run on a browser and hardware GPU. Looking at the
preview is not evidence.

## Capture procedure

1. Open the static BenchDev page through the browser acceptance harness. Keep the 320 by 180 preview
   unobscured and at 100 percent browser zoom. Start the run with a direct click on this origin.
2. Before the GPU phase, start a Chromium DevTools Protocol `Page.startScreencast` recording with
   `format: "png"`. Record the browser compositor, not `gl.readPixels`, and acknowledge every
   `Page.screencastFrame`. Stop only after the GPU phase ends. This is a verification run and its
   timing result must be discarded.
3. Preserve every received frame and its `metadata.timestamp`. Do not choose representative frames.
   Decode every PNG, crop the preview using its fixed bounding rectangle, and resample only if the
   capture scale is not one device pixel per preview pixel. The decoded crop passed to the assertion
   must be exactly 320 by 180 RGBA pixels.
4. Number decoded frames consecutively from zero in capture order. Pass all frames to
   `assertRecordedGpuCapture` from `t4-acceptance.js` as:

   ```js
   {
     source: "recorded-compositor-capture",
     width: 320,
     height: 180,
     frames: [{ frameIndex, timestampMs, rgba }]
   }
   ```

5. Run the same capture once with `previewMode: "standard"` and once with
   `previewMode: "reduced-motion"`. In both runs, also execute `runT4BrowserAcceptance`. It asserts
   the same preview size and one-blit-per-work-unit cadence. The recorded-capture assertion converts
   every pixel to WCAG relative luminance, checks every consecutive frame pair, and rejects a gap or
   reordering in the decoded recording.

## Other browser runs

- Run `runT4BrowserAcceptance` on a hardware-backed browser.
- Run it again with the browser's documented SwiftShader switch. It must return
  `gpuMeasurement: null`, and `validity.js` must return `software-renderer-detected`.
- On hardware, run `runT4ContextLossAcceptance`. It invokes `WEBGL_lose_context` before teardown and
  requires an invalid result with no score. The existing T1 teardown loss remains non-invalidating.

These files provide assertions but do not claim a browser, GPU, software renderer, compositor
recording, or context-loss run happened in the bare Node suite.
