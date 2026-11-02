import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_STYLE,
  CustomShaderPass,
  customShaderErrors,
  customShaderFragment,
  ShaderClock,
  ShaderCursorTracker,
  shaderCursorRect,
  shaderDate,
} from "./customShader";

describe("custom shader render target", () => {
  function target() {
    const texture = {} as WebGLTexture;
    const framebuffer = {} as WebGLFramebuffer;
    const gl = {
      TEXTURE_2D: 1,
      RGBA8: 2,
      TEXTURE_MIN_FILTER: 3,
      TEXTURE_MAG_FILTER: 4,
      LINEAR: 5,
      TEXTURE_WRAP_S: 6,
      TEXTURE_WRAP_T: 7,
      CLAMP_TO_EDGE: 8,
      FRAMEBUFFER: 9,
      COLOR_ATTACHMENT0: 10,
      FRAMEBUFFER_COMPLETE: 11,
      createTexture: vi.fn(() => texture as WebGLTexture | null),
      createFramebuffer: vi.fn(() => framebuffer as WebGLFramebuffer | null),
      bindTexture: vi.fn(),
      texStorage2D: vi.fn(),
      texParameteri: vi.fn(),
      bindFramebuffer: vi.fn(),
      framebufferTexture2D: vi.fn(),
      checkFramebufferStatus: vi.fn(() => 11),
      deleteTexture: vi.fn(),
      deleteFramebuffer: vi.fn(),
      deleteProgram: vi.fn(),
    };
    return {
      gl,
      texture,
      framebuffer,
      pass: new CustomShaderPass(
        gl as unknown as WebGL2RenderingContext,
        {} as WebGLProgram,
      ),
    };
  }

  it("reports a failed texture allocation and can retry", () => {
    const { gl, pass } = target();
    gl.createTexture.mockReturnValueOnce(null);
    expect(() => pass.begin(80, 40)).toThrow(/texture/i);
    expect(gl.createFramebuffer).not.toHaveBeenCalled();
    expect(() => pass.begin(80, 40)).not.toThrow();
  });

  it("releases the texture if framebuffer allocation fails", () => {
    const { gl, texture, pass } = target();
    gl.createFramebuffer.mockReturnValueOnce(null);
    expect(() => pass.begin(80, 40)).toThrow(/framebuffer/i);
    expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
    expect(() => pass.begin(80, 40)).not.toThrow();
  });

  it("rejects and releases an incomplete framebuffer before retrying", () => {
    const { gl, texture, framebuffer, pass } = target();
    gl.checkFramebufferStatus.mockReturnValueOnce(99);
    expect(() => pass.begin(80, 40)).toThrow(/framebuffer/i);
    expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
    expect(gl.deleteFramebuffer).toHaveBeenCalledWith(framebuffer);
    expect(() => pass.begin(80, 40)).not.toThrow();
    expect(gl.checkFramebufferStatus).toHaveBeenCalledTimes(2);
    pass.begin(80, 40);
    expect(gl.checkFramebufferStatus).toHaveBeenCalledTimes(2);
  });
});

const MAIN_IMAGE = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = texture(iChannel0, fragCoord / iResolution.xy);
}
`;

describe("custom shader source", () => {
  it("wraps mainImage in WebGL2 GLSL with Ghostty's uniforms", () => {
    const source = customShaderFragment(MAIN_IMAGE);
    expect(source.startsWith("#version 300 es\n")).toBe(true);
    for (const uniform of [
      "uniform vec3 iResolution;",
      "uniform float iTime;",
      "uniform vec4 iCurrentCursor;",
      "uniform vec4 iPreviousCursor;",
      "uniform float iTimeCursorChange;",
      "uniform sampler2D iChannel0;",
    ])
      expect(source).toContain(uniform);
    expect(source).toContain("#define texture2D texture");
    // Compiler line numbers count from the user's first line.
    expect(source.indexOf("#line 1\n")).toBeLessThan(
      source.indexOf("fragColor = texture(iChannel0"),
    );
    expect(
      source
        .trimEnd()
        .endsWith("void main() { mainImage(_fragColor, gl_FragCoord.xy); }"),
    ).toBe(true);
  });

  it("drops a #version line and a byte-order mark of the user's own", () => {
    const bom = String.fromCharCode(0xfeff);
    const source = customShaderFragment(
      `${bom}#version 330 core\n${MAIN_IMAGE}`,
    );
    expect(source.match(/#version/g)).toHaveLength(1);
    expect(source).not.toContain(bom);
  });

  it("reports compiler errors by the user's line numbers", () => {
    expect(
      customShaderErrors(
        "ERROR: 0:3: '' :  syntax error, unexpected RIGHT_BRACE\nERROR: 1 compilation errors.  No code generated.\n\u0000",
      ),
    ).toBe(
      "line 3: '' :  syntax error, unexpected RIGHT_BRACE\nERROR: 1 compilation errors.  No code generated.",
    );
  });
});

describe("custom shader uniforms", () => {
  const cursor = (x: number, color = 1) => ({
    rect: [x, 100, 8, 16] as const,
    color: [color, color, color, 1] as const,
    style: CURSOR_STYLE.block,
    visible: true,
  });

  it("keeps the last position and the time it changed, as Ghostty does", () => {
    const tracker = new ShaderCursorTracker();
    tracker.update(cursor(0), 0.5);
    tracker.update(cursor(8), 1.25);
    expect(tracker.current.rect[0]).toBe(8);
    expect(tracker.previous.rect[0]).toBe(0);
    expect(tracker.changedAt).toBe(1.25);
    // An unchanged cursor keeps the previous one and the change time.
    tracker.update(cursor(8), 2);
    expect(tracker.previous.rect[0]).toBe(0);
    expect(tracker.changedAt).toBe(1.25);
    // A colour change counts as a change.
    tracker.update(cursor(8, 0.5), 3);
    expect(tracker.previous.color[0]).toBe(1);
    expect(tracker.changedAt).toBe(3);
  });

  it("moves the style to the previous style on every update", () => {
    const tracker = new ShaderCursorTracker();
    tracker.update({ ...cursor(0), style: CURSOR_STYLE.bar }, 0);
    tracker.update({ ...cursor(0), style: CURSOR_STYLE.underline }, 1);
    expect(tracker.previousStyle).toBe(CURSOR_STYLE.bar);
    expect(tracker.current.style).toBe(CURSOR_STYLE.underline);
  });

  it("counts time and frames from the first tick", () => {
    const clock = new ShaderClock(1_000);
    clock.tick(1_000);
    expect([clock.time, clock.delta, clock.frame]).toEqual([0, 0, 1]);
    clock.tick(1_016);
    expect(clock.time).toBeCloseTo(0.016, 6);
    expect(clock.delta).toBeCloseTo(0.016, 6);
    expect(clock.frame).toBe(2);
  });

  it("gives Shadertoy's iDate", () => {
    expect(shaderDate(new Date(2026, 9, 22, 1, 2, 3))).toEqual([
      2026, 9, 22, 3_723,
    ]);
  });

  // Ghostty's OpenGL convention: left and top edges with y up, as
  // gl_FragCoord counts, so trail shaders written for it line up.
  it("places the cursor rectangle as Ghostty's OpenGL renderer does", () => {
    // Column 3, row 2 of 10x20 cells on a 400 px tall canvas.
    expect(shaderCursorRect(3, 2, "block", 10, 20, 400)).toEqual([
      30, 360, 10, 20,
    ]);
    expect(shaderCursorRect(3, 2, "bar", 10, 20, 400)).toEqual([
      30, 360, 1.2, 20,
    ]);
    const [, top, , height] = shaderCursorRect(3, 2, "underline", 10, 20, 400);
    // The underline's top edge is its height above the cell's bottom.
    expect(top - height).toBeCloseTo(400 - 60, 6);
    expect(height).toBeCloseTo(2.4, 6);
  });
});
