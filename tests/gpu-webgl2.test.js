import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveGpuFeedbackChain,
  GPU_FEEDBACK_INITIAL_STATE,
  GPU_FRAGMENT_SHADER_SOURCE,
  GPU_PREVIEW_SURFACE_PX,
  GPU_RENDER_TARGET_PX,
  GPU_VERTEX_SHADER_SOURCE,
} from "../src/workloads/gpu.js";
import { GPU_PREVIEW_FRAGMENT_SHADER_SOURCE } from "../src/workloads/gpu-preview.js";
import { createGpuWebGl2Adapter } from "../src/workloads/gpu-webgl2.js";

function fakeWebGl2() {
  let nextId = 1;
  let readbackValue = 0;
  const calls = [];
  const shaders = [];
  const programs = [];
  const textures = [];
  const framebuffers = [];
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    R32UI: 0x8236,
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR: 0x1800,
    RED_INTEGER: 0x8d94,
    UNSIGNED_INT: 0x1405,
    TRIANGLES: 0x0004,
    TEXTURE0: 0x84c0,
    NO_ERROR: 0,
    createShader(type) {
      const shader = { id: nextId, type, source: null };
      nextId += 1;
      shaders.push(shader);
      return shader;
    },
    shaderSource(shader, source) { shader.source = source; },
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ""; },
    deleteShader() {},
    createProgram() {
      const program = { id: nextId, shaders: [] };
      nextId += 1;
      programs.push(program);
      return program;
    },
    attachShader(program, shader) { program.shaders.push(shader); },
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ""; },
    deleteProgram() {},
    createVertexArray() { return { id: nextId++ }; },
    createTexture() {
      const texture = { id: nextId++ };
      textures.push(texture);
      return texture;
    },
    createFramebuffer() {
      const framebuffer = { id: nextId++ };
      framebuffers.push(framebuffer);
      return framebuffer;
    },
    bindTexture(target, texture) { calls.push(["bindTexture", target, texture]); },
    texParameteri() {},
    texStorage2D() {},
    bindFramebuffer(target, framebuffer) {
      calls.push(["bindFramebuffer", target, framebuffer]);
    },
    framebufferTexture2D(target, attachment, textureTarget, texture) {
      calls.push(["framebufferTexture2D", target, attachment, textureTarget, texture]);
    },
    checkFramebufferStatus() { return gl.FRAMEBUFFER_COMPLETE; },
    clearBufferuiv(buffer, drawBuffer, values) {
      calls.push(["clearBufferuiv", buffer, drawBuffer, [...values]]);
    },
    getUniformLocation(program, name) { return { program, name }; },
    isContextLost() { return false; },
    viewport(x, y, width, height) { calls.push(["viewport", x, y, width, height]); },
    useProgram(program) { calls.push(["useProgram", program]); },
    bindVertexArray(vertexArray) { calls.push(["bindVertexArray", vertexArray]); },
    uniform1i(location, value) { calls.push(["uniform1i", location.name, value]); },
    uniform1ui(location, value) { calls.push(["uniform1ui", location.name, value]); },
    uniform1f(location, value) { calls.push(["uniform1f", location.name, value]); },
    activeTexture(texture) { calls.push(["activeTexture", texture]); },
    drawArrays(mode, first, count) { calls.push(["drawArrays", mode, first, count]); },
    readBuffer(attachment) { calls.push(["readBuffer", attachment]); },
    readPixels(x, y, width, height, format, type, destination) {
      calls.push(["readPixels", x, y, width, height, format, type]);
      destination[0] = readbackValue;
    },
    finish() { calls.push(["finish"]); },
    getError() { calls.push(["getError"]); return gl.NO_ERROR; },
  };

  return {
    gl,
    calls,
    shaders,
    programs,
    textures,
    framebuffers,
    setReadbackValue(value) { readbackValue = value; },
  };
}

test("a timed unit ping-pongs every frame and verifies one final readback", () => {
  const fake = fakeWebGl2();
  const adapter = createGpuWebGl2Adapter({
    gl: fake.gl,
    renderTargetPx: GPU_RENDER_TARGET_PX,
    previewSurfacePx: GPU_PREVIEW_SURFACE_PX,
    vertexShaderSource: GPU_VERTEX_SHADER_SOURCE,
    fragmentShaderSource: GPU_FRAGMENT_SHADER_SOURCE,
    previewFragmentShaderSource: GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
    initialFeedbackState: GPU_FEEDBACK_INITIAL_STATE,
  });
  const setupCallCount = fake.calls.length;

  adapter.renderFrame({ complexityLevel: 4, frameIndex: 0, phaseRadians: 0 });
  adapter.renderFrame({ complexityLevel: 4, frameIndex: 1, phaseRadians: 0.1 });
  assert.equal(
    fake.calls.slice(setupCallCount).filter(([name]) => name === "finish").length,
    0,
    "a sub-frame synchronisation would put driver round trips back into the timing",
  );
  const expectedFeedbackState = deriveGpuFeedbackChain({
    complexityLevel: 4,
    firstFrameIndex: 0,
    frameCount: 2,
  });
  fake.setReadbackValue(expectedFeedbackState);
  assert.deepEqual(adapter.completeTimedUnit(expectedFeedbackState), {
    actual: expectedFeedbackState,
    expected: expectedFeedbackState,
  });
  const renderCalls = fake.calls.slice(setupCallCount);
  const draws = renderCalls.filter(([name]) => name === "drawArrays");

  assert.equal(draws.length, 4, "each measured frame must include its scene and preview draw");
  assert.deepEqual(
    renderCalls.filter(([name]) => name === "viewport").map((call) => call.slice(3)),
    [[1280, 720], [320, 180], [1280, 720], [320, 180]],
  );
  assert.ok(renderCalls.some((call) => (
    call[0] === "bindFramebuffer"
      && call[1] === fake.gl.FRAMEBUFFER
      && call[2] === null
  )), "the presentation draw did not target the default framebuffer");
  assert.ok(renderCalls.some((call) => (
    call[0] === "uniform1i" && call[1] === "u_previous_state" && call[2] === 0
  )), "the workload shader did not sample the preceding state texture");
  assert.deepEqual(
    renderCalls.filter(([name]) => name === "bindTexture").map((call) => call[2]),
    [fake.textures[0], fake.textures[1], fake.textures[1], fake.textures[0]],
    "the two state textures did not alternate between input and output",
  );
  assert.equal(renderCalls.filter(([name]) => name === "readPixels").length, 1);
  assert.deepEqual(
    renderCalls.find(([name]) => name === "readPixels").slice(1, 5),
    [0, 0, 1, 1],
    "the timed unit must read only one final pixel",
  );
  assert.equal(renderCalls.filter(([name]) => name === "finish").length, 0);
  assert.equal(renderCalls.at(-1)[0], "getError", "the WebGL error check was weakened or removed");
  assert.equal("blitFramebuffer" in fake.gl, false);
});

test("a mismatched final GPU feedback value fails loudly", () => {
  const fake = fakeWebGl2();
  const adapter = createGpuWebGl2Adapter({
    gl: fake.gl,
    renderTargetPx: GPU_RENDER_TARGET_PX,
    previewSurfacePx: GPU_PREVIEW_SURFACE_PX,
    vertexShaderSource: GPU_VERTEX_SHADER_SOURCE,
    fragmentShaderSource: GPU_FRAGMENT_SHADER_SOURCE,
    previewFragmentShaderSource: GPU_PREVIEW_FRAGMENT_SHADER_SOURCE,
    initialFeedbackState: GPU_FEEDBACK_INITIAL_STATE,
  });

  adapter.renderFrame({ complexityLevel: 4, frameIndex: 0, phaseRadians: 0 });
  fake.setReadbackValue(0);
  assert.throws(
    () => adapter.completeTimedUnit(1),
    /GPU feedback checksum mismatch: expected 1, received 0/,
  );
});
