function compileShader(gl, type, source) {
  const shader = gl.createShader(type);

  if (shader === null) {
    throw new Error("WebGL2 could not allocate a shader");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader compiler error";
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compilation failed: ${message}`);
  }

  return shader;
}

function linkProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();

  if (program === null) {
    throw new Error("WebGL2 could not allocate a program");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown program linker error";
    gl.deleteProgram(program);
    throw new Error(`WebGL2 program linking failed: ${message}`);
  }

  return program;
}

function requiredUniform(gl, program, name) {
  const location = gl.getUniformLocation(program, name);

  if (location === null) {
    throw new Error(`WebGL2 did not retain required uniform ${name}`);
  }

  return location;
}

export function createGpuWebGl2Context(canvas, { width, height }, contextAttributes) {
  if (canvas === null || typeof canvas !== "object"
      || typeof canvas.getContext !== "function") {
    throw new TypeError("A canvas is required for the WebGL2 preview");
  }

  canvas.width = width;
  canvas.height = height;

  if (canvas.style !== undefined) {
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const gl = canvas.getContext("webgl2", contextAttributes);

  if (gl === null) {
    throw new Error("WebGL2 is required for the GPU workload");
  }

  return gl;
}

export function createGpuWebGl2Adapter({
  gl,
  renderTargetPx,
  previewSurfacePx,
  vertexShaderSource,
  fragmentShaderSource,
  previewFragmentShaderSource,
  initialFeedbackState,
}) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const previewFragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    previewFragmentShaderSource,
  );
  const program = linkProgram(gl, vertexShader, fragmentShader);
  const previewProgram = linkProgram(gl, vertexShader, previewFragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  gl.deleteShader(previewFragmentShader);

  const vertexArray = gl.createVertexArray();
  const targetTextures = [gl.createTexture(), gl.createTexture()];
  const targetFramebuffers = [gl.createFramebuffer(), gl.createFramebuffer()];

  if (vertexArray === null
      || targetTextures.includes(null)
      || targetFramebuffers.includes(null)) {
    throw new Error("WebGL2 could not allocate the procedural feedback targets");
  }

  for (let index = 0; index < targetTextures.length; index += 1) {
    gl.bindTexture(gl.TEXTURE_2D, targetTextures[index]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      gl.R32UI,
      renderTargetPx.width,
      renderTargetPx.height,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFramebuffers[index]);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      targetTextures[index],
      0,
    );

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("WebGL2 could not complete a fixed procedural feedback target");
    }

    gl.clearBufferuiv(
      gl.COLOR,
      0,
      new Uint32Array([initialFeedbackState, 0, 0, 0]),
    );
  }

  const complexityUniform = requiredUniform(gl, program, "u_complexity");
  const previousStateUniform = requiredUniform(gl, program, "u_previous_state");
  const frameIndexUniform = requiredUniform(gl, program, "u_frame_index");
  const renderTargetUniform = requiredUniform(gl, previewProgram, "u_render_target");
  const phaseUniform = requiredUniform(gl, previewProgram, "u_phase");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Complete the one-time seed initialisation before any measured unit begins. Thereafter the
  // two textures retain one continuous state chain for the whole workload.
  gl.finish();

  if (gl.getError() !== gl.NO_ERROR) {
    throw new Error("WebGL2 could not initialise the procedural feedback chain");
  }

  let previousTargetIndex = 0;
  let nextTargetIndex = 1;
  let framesSinceReadback = 0;

  function assertContextAvailable() {
    if (gl.isContextLost()) {
      throw new Error("The WebGL2 context was lost during the GPU workload");
    }
  }

  return Object.freeze({
    renderFrame({ complexityLevel, frameIndex, phaseRadians }) {
      assertContextAvailable();
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targetFramebuffers[nextTargetIndex]);
      gl.viewport(0, 0, renderTargetPx.width, renderTargetPx.height);
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetTextures[previousTargetIndex]);
      gl.uniform1i(previousStateUniform, 0);
      gl.uniform1i(complexityUniform, complexityLevel);
      gl.uniform1ui(frameIndexUniform, frameIndex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // This preview draw is inside the measured work unit. Its dimensions and once-per-frame
      // cadence come from the protocol plan and do not branch on an accessibility preference.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, previewSurfacePx.width, previewSurfacePx.height);
      gl.useProgram(previewProgram);
      gl.bindVertexArray(vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targetTextures[nextTargetIndex]);
      gl.uniform1i(renderTargetUniform, 0);
      gl.uniform1f(phaseUniform, phaseRadians);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      previousTargetIndex = nextTargetIndex;
      nextTargetIndex = 1 - nextTargetIndex;
      framesSinceReadback += 1;
    },
    completeTimedUnit(expectedFeedbackState) {
      if (framesSinceReadback === 0) {
        throw new Error("A GPU timed unit must render before it can be completed");
      }

      const actualFeedbackState = new Uint32Array(1);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targetFramebuffers[previousTargetIndex]);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(
        0,
        0,
        1,
        1,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        actualFeedbackState,
      );
      assertContextAvailable();

      const error = gl.getError();

      if (error !== gl.NO_ERROR) {
        throw new Error(`WebGL2 reported error 0x${error.toString(16)} during the GPU workload`);
      }

      if (actualFeedbackState[0] !== expectedFeedbackState) {
        throw new Error(
          `GPU feedback checksum mismatch: expected ${expectedFeedbackState}, `
          + `received ${actualFeedbackState[0]}`,
        );
      }

      framesSinceReadback = 0;
      return Object.freeze({
        actual: actualFeedbackState[0],
        expected: expectedFeedbackState,
      });
    },
  });
}
