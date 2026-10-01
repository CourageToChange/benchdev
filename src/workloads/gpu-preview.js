export const GPU_PREVIEW_DRAWS_PER_WORK_UNIT = 1;

// This samples only the procedural state target produced in the same work unit. It is not an
// asset. sin() closes every possible feedback state into the fixed luminance interval, so state
// cannot accumulate into a brighter or darker preview across frames.
export const GPU_PREVIEW_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_position;
uniform highp usampler2D u_render_target;
uniform float u_phase;
out vec4 fragment_colour;

const float CENTRE_SRGB = 0.35;
const float AMPLITUDE_SRGB = 0.008;
const float TAU = 6.283185307179586;

void main() {
  uint state = texture(u_render_target, v_position).r;
  float pattern = sin(float(state & 65535u) * (TAU / 65535.0) + u_phase);
  float encoded_luminance = CENTRE_SRGB + AMPLITUDE_SRGB * pattern;
  fragment_colour = vec4(vec3(encoded_luminance), 1.0);
}
`;
