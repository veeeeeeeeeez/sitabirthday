// Super 8 emulation. This runs the camera through a real WebGL pipeline rather
// than laying a texture over the top, so what you see is what gets recorded:
//
//   pass 1  bright-pass + horizontal blur   (quarter res)
//   pass 2  vertical blur                   (quarter res)  -> halation
//   pass 3  composite: weave, lens, grade, halation, grain, gate, vignette
//
// The physical behaviours worth naming, because they are what sells it:
//   * halation - light scatters off the film base and blooms back through the
//     emulsion, warm and red-biased. This is the orange glow around highlights.
//   * grain    - clumps of developed silver at a fixed physical size, so it does
//     NOT scale with resolution, and it peaks in the midtones rather than being
//     uniform noise.
//   * gate weave - the cartridge never holds the frame quite still; vertical
//     drift is worse than horizontal, with the odd jump.
//   * flicker  - shutter and exposure vary frame to frame.
//   * Super 8 runs at 18fps, so the source is sampled at 18fps and held, which
//     is where the judder comes from.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

// Pull the highlights and blur them sideways. Weighted toward red because
// halation in real stock scatters longest in the red layer.
const BRIGHT_H = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;

// The camera hands us whatever shape it likes (often 16:9 or a portrait
// sensor) while the film frame has its own aspect. Sampling the whole texture
// into a differently shaped canvas stretches the picture - that is what
// squashes a face. So crop to a centred sub-rect instead, exactly like
// object-fit: cover.
uniform vec2 uSrcSize;
uniform vec2 uOutSize;

vec2 coverUv(vec2 uv) {
  float srcA = uSrcSize.x / max(uSrcSize.y, 1.0);
  float outA = uOutSize.x / max(uOutSize.y, 1.0);
  vec2 s = vec2(1.0);
  if (srcA > outA) s.x = outA / srcA; else s.y = srcA / outA;
  return (uv - 0.5) * s + 0.5;
}

void main() {
  vec3 sum = vec3(0.0);
  float weights[5];
  weights[0] = 0.227; weights[1] = 0.194; weights[2] = 0.121; weights[3] = 0.054; weights[4] = 0.016;
  for (int i = -4; i <= 4; i++) {
    float w = weights[int(abs(float(i)))];
    vec3 c = texture2D(uTex, coverUv(vUv + vec2(float(i) * uTexel.x * 2.0, 0.0))).rgb;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    // Only the top of the range blooms, easing in rather than clipping on.
    vec3 hi = c * smoothstep(0.62, 1.0, l);
    sum += hi * w;
  }
  gl_FragColor = vec4(sum, 1.0);
}`

const BLUR_V = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;

void main() {
  vec3 sum = vec3(0.0);
  float weights[5];
  weights[0] = 0.227; weights[1] = 0.194; weights[2] = 0.121; weights[3] = 0.054; weights[4] = 0.016;
  for (int i = -4; i <= 4; i++) {
    float w = weights[int(abs(float(i)))];
    sum += texture2D(uTex, vUv + vec2(0.0, float(i) * uTexel.y * 2.0)).rgb * w;
  }
  gl_FragColor = vec4(sum, 1.0);
}`

const COMPOSITE = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uTex;      // camera frame
uniform sampler2D uBloom;    // halation
uniform vec2 uRes;
uniform float uSeed;         // changes once per film frame
uniform vec2 uWeave;         // gate weave, in uv
uniform float uExposure;     // per-frame flicker
uniform float uStartup;      // 1 -> 0 as the camera runs up to speed
uniform float uGrain;
uniform float uDust;
uniform float uBlank;    // 1 = unexposed leader, no camera yet

// The camera hands us whatever shape it likes (often 16:9 or a portrait
// sensor) while the film frame has its own aspect. Sampling the whole texture
// into a differently shaped canvas stretches the picture - that is what
// squashes a face. So crop to a centred sub-rect instead, exactly like
// object-fit: cover.
uniform vec2 uSrcSize;
uniform vec2 uOutSize;

vec2 coverUv(vec2 uv) {
  float srcA = uSrcSize.x / max(uSrcSize.y, 1.0);
  float outA = uOutSize.x / max(uOutSize.y, 1.0);
  vec2 s = vec2(1.0);
  if (srcA > outA) s.x = outA / srcA; else s.y = srcA / outA;
  return (uv - 0.5) * s + 0.5;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Value noise, so grain clumps instead of looking like per-pixel static.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec2 uv = vUv;

  // --- gate weave + a touch of barrel distortion from a cheap plastic lens ---
  uv += uWeave;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  uv = 0.5 + c * (1.0 + 0.030 * r2);

  uv = clamp(uv, 0.0015, 0.9985);

  // --- the picture, or blank leader before the camera is running ---
  vec2 suv = coverUv(uv);
  vec2 dir = c * 0.0038;
  vec3 col;
  if (uBlank > 0.5) {
    // Unexposed stock idling in the gate: a dark grey base with the emulsion
    // mottling through it. Everything below still applies, so it grains,
    // flickers and vignettes like real leader.
    float mottle = vnoise(vUv * 3.0 + uSeed * 0.7) * 0.045
                 + vnoise(vUv * 11.0 + uSeed * 1.9) * 0.022;
    col = vec3(0.105, 0.100, 0.093) + mottle;
  } else {
    col.r = texture2D(uTex, suv + dir).r;
    col.g = texture2D(uTex, suv).g;
    col.b = texture2D(uTex, suv - dir).b;
  }

  // --- exposure: shutter flicker, plus the run-up when the motor starts ---
  col *= uExposure;
  col += uStartup * 0.55 * vec3(1.0, 0.92, 0.78);

  // --- halation ---
  vec3 bloom = texture2D(uBloom, uv).rgb;
  col += bloom * vec3(0.62, 0.30, 0.16) * 1.5 * (1.0 - uBlank);

  // --- Kodachrome-ish grade: warm highlights, green-teal lifted shadows ---
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, 0.90);                       // pull saturation back a little
  // Gamma below 1 brightens a channel, so red goes down and blue goes up to
  // warm the midtones.
  col = pow(max(col, 0.0), vec3(0.965, 1.0, 1.040));
  // Reversal stock scanned off a projector has milky shadows, not crushed ones.
  col.rgb += vec3(0.030, 0.036, 0.034) * (1.0 - l) * (1.0 - l);
  col.r += 0.022 * l;                                  // warm the shoulder
  col.b -= 0.014 * l;
  // Soft shoulder rather than a hard clip.
  col = col / (1.0 + max(col - 0.78, 0.0) * 1.5);
  col = clamp(col, 0.0, 1.0);

  // --- grain: fixed physical size, peaks in the midtones, blue layer worst ---
  float gScale = uRes.y / 1.15;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  // Grain peaks in the midtones and all but vanishes in blown highlights.
  float response = smoothstep(0.015, 0.30, lum) * (1.0 - smoothstep(0.62, 1.0, lum));
  response = 0.30 + response * 0.90;
  vec2 gp = vUv * gScale;
  // Two octaves so the clumps have structure instead of a single blob size.
  float g = (vnoise(gp + uSeed * 91.7) - 0.5) * 0.68
          + (vnoise(gp * 2.3 + uSeed * 47.3) - 0.5) * 0.32;
  // Mostly luminance, with just enough chroma wobble to avoid looking digital.
  float gc = (vnoise(gp * 1.6 + uSeed * 63.1 + 51.0) - 0.5) * 0.30;
  col += (vec3(g) + vec3(gc * 0.5, -gc * 0.25, gc * 0.7)) * uGrain * response;

  // --- dust and the occasional scratch, only now and then ---
  float dustCell = hash(floor(vUv * vec2(180.0, 240.0)) + uSeed * 13.0);
  if (dustCell > 1.0 - uDust) col += vec3(0.55);
  float scratchX = hash(vec2(floor(uSeed * 7.0), 3.0));
  if (uDust > 0.0 && abs(vUv.x - scratchX) < 0.0016 &&
      hash(vec2(floor(uSeed * 7.0), 9.0)) > 0.85) {
    col += vec3(0.20, 0.19, 0.17);
  }

  // --- vignette ---
  float v = smoothstep(0.98, 0.30, length(c * vec2(1.04, 1.0)));
  col *= mix(0.66, 1.0, v);

  // --- the gate edge ---
  // The aperture is a cut piece of metal and the emulsion edge behind it is
  // never straight, so the frame border wanders and goes soft. The seeds are
  // constants on purpose: the film travels but the gate does not, so a border
  // that boiled frame to frame would give the whole thing away.
  float wob = 0.013;
  float bl = 0.020 + (vnoise(vec2(vUv.y * 13.0, 4.20)) - 0.5) * wob;
  float br = 0.020 + (vnoise(vec2(vUv.y * 13.0, 8.71)) - 0.5) * wob;
  float bt = 0.017 + (vnoise(vec2(vUv.x * 13.0, 2.35)) - 0.5) * wob;
  float bb = 0.017 + (vnoise(vec2(vUv.x * 13.0, 6.04)) - 0.5) * wob;
  float gate = smoothstep(0.0, bl, vUv.x) * smoothstep(0.0, br, 1.0 - vUv.x) *
               smoothstep(0.0, bt, vUv.y) * smoothstep(0.0, bb, 1.0 - vUv.y);

  // Black corruption: the emulsion has lifted away in patches along the
  // border, so on top of the wandering edge there are places where the black
  // bites much further into the picture. Patchy, not a uniform inset.
  float dEdge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float patch = vnoise(vec2(vUv.x * 6.0 + vUv.y * 6.0, vUv.y * 6.0 - vUv.x * 4.0) + 17.0);
  float fineBite = vnoise(vec2(vUv.x * 41.0, vUv.y * 41.0) + 5.0);
  float bite = smoothstep(0.52, 0.95, patch) * (0.030 + fineBite * 0.030);
  gate *= smoothstep(0.0, max(bite, 0.0008), dEdge);

  col *= gate;

  gl_FragColor = vec4(col, 1.0);
}`

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`)
  }
  return sh
}

function program(gl, fsSrc) {
  const p = gl.createProgram()
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc))
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`)
  }
  return p
}

function makeTarget(gl, w, h) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fbo, w, h }
}

export class FilmProjector {
  constructor(canvas) {
    this.canvas = canvas
    const opts = { preserveDrawingBuffer: true, alpha: false, antialias: false }
    this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts)
    if (!this.gl) throw new Error('WebGL unavailable')

    const gl = this.gl
    this.progBright = program(gl, BRIGHT_H)
    this.progBlur = program(gl, BLUR_V)
    this.progComp = program(gl, COMPOSITE)

    this.quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

    this.srcTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    this.targets = null
    this.raf = 0
    this.source = null
    this.running = false
    // Idle state runs blank leader; flicker is the shutter, and it is stilled
    // once recording starts.
    this.blank = true
    this.flicker = true
    // A take holds still: no shutter flicker, no scratch flashes, and the
    // weave damped right down. Everything that reads as "flickering" comes
    // from one of those three.
    this.steady = false

    // Film-frame state, advanced at 18fps rather than display rate.
    this.frameSeed = Math.random() * 1000
    this.exposure = 1
    this.weave = [0, 0]
    this.weavePhase = Math.random() * 100
    this.lastFilmFrame = 0
    this.startedAt = 0
  }

  resize(w, h) {
    const gl = this.gl
    if (this.canvas.width === w && this.canvas.height === h && this.targets) return
    this.canvas.width = w
    this.canvas.height = h
    const bw = Math.max(2, w >> 2)
    const bh = Math.max(2, h >> 2)
    if (this.targets) {
      for (const t of this.targets) {
        gl.deleteTexture(t.tex)
        gl.deleteFramebuffer(t.fbo)
      }
    }
    this.targets = [makeTarget(gl, bw, bh), makeTarget(gl, bw, bh)]
  }

  drawQuad(prog) {
    const gl = this.gl
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Advance the mechanical state one film frame.
  advanceFrame(elapsed) {
    this.frameSeed = Math.random() * 1000

    // Shutter flicker, with the motor settling over the first second.
    const runUp = Math.max(0, 1 - elapsed / 1.1)
    this.exposure = this.flicker ? 1 + (Math.random() - 0.5) * (0.045 + runUp * 0.22) : 1

    // Weave: vertical drift dominates, with the occasional jolt.
    this.weavePhase += 0.28
    const damp = this.steady ? 0.3 : 1
    const jump = !this.steady && Math.random() < 0.03 ? (Math.random() - 0.5) * 0.012 : 0
    this.weave = [
      (Math.sin(this.weavePhase * 0.7) * 0.0016 + (Math.random() - 0.5) * 0.0011) * damp,
      (Math.cos(this.weavePhase * 0.43) * 0.0034 + (Math.random() - 0.5) * 0.0018 + jump) * damp,
    ]
  }

  render(now) {
    const gl = this.gl
    const src = this.source
    if (!src && !this.blank) return

    const vw = (src && (src.videoWidth || src.naturalWidth || src.width)) || this.canvas.width
    const vh = (src && (src.videoHeight || src.naturalHeight || src.height)) || this.canvas.height
    if (!vw || !vh) return

    const elapsed = (now - this.startedAt) / 1000

    // Sample and hold at 18fps: this is where the judder comes from.
    const filmFrame = Math.floor(elapsed * 18)
    const isNewFrame = filmFrame !== this.lastFilmFrame
    if (isNewFrame) {
      this.lastFilmFrame = filmFrame
      this.advanceFrame(elapsed)
      if (src) {
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
        } catch {
          return // frame not decodable yet
        }
      }
    }

    const [a, b] = this.targets
    const blank = this.blank || !src

    if (!blank) {
    // pass 1 — bright pass + horizontal blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo)
    gl.viewport(0, 0, a.w, a.h)
    gl.useProgram(this.progBright)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.uniform1i(gl.getUniformLocation(this.progBright, 'uTex'), 0)
    gl.uniform2f(gl.getUniformLocation(this.progBright, 'uTexel'), 1 / a.w, 1 / a.h)
    gl.uniform2f(gl.getUniformLocation(this.progBright, 'uSrcSize'), vw, vh)
    gl.uniform2f(gl.getUniformLocation(this.progBright, 'uOutSize'), this.canvas.width, this.canvas.height)
    this.drawQuad(this.progBright)

    // pass 2 — vertical blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo)
    gl.viewport(0, 0, b.w, b.h)
    gl.useProgram(this.progBlur)
    gl.bindTexture(gl.TEXTURE_2D, a.tex)
    gl.uniform1i(gl.getUniformLocation(this.progBlur, 'uTex'), 0)
    gl.uniform2f(gl.getUniformLocation(this.progBlur, 'uTexel'), 1 / b.w, 1 / b.h)
    this.drawQuad(this.progBlur)
    }

    // pass 3 — composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const p = this.progComp
    gl.useProgram(p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, b.tex)
    gl.uniform1i(gl.getUniformLocation(p, 'uBloom'), 1)
    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), this.canvas.width, this.canvas.height)
    gl.uniform2f(gl.getUniformLocation(p, 'uSrcSize'), vw, vh)
    gl.uniform2f(gl.getUniformLocation(p, 'uOutSize'), this.canvas.width, this.canvas.height)
    gl.uniform1f(gl.getUniformLocation(p, 'uSeed'), this.frameSeed)
    gl.uniform2f(gl.getUniformLocation(p, 'uWeave'), this.weave[0], this.weave[1])
    gl.uniform1f(gl.getUniformLocation(p, 'uExposure'), this.exposure)
    // The lamp flares up as the motor comes to speed, then settles.
    gl.uniform1f(
      gl.getUniformLocation(p, 'uStartup'),
      this.steady ? 0 : Math.max(0, 1 - elapsed / 0.75) ** 2,
    )
    gl.uniform1f(gl.getUniformLocation(p, 'uGrain'), blank ? 0.16 : 0.055)
    gl.uniform1f(gl.getUniformLocation(p, 'uDust'), this.steady ? 0 : blank ? 0.0011 : 0.00035)
    gl.uniform1f(gl.getUniformLocation(p, 'uBlank'), blank ? 1 : 0)
    this.drawQuad(p)
    gl.activeTexture(gl.TEXTURE0)
  }

  start(source, width, height) {
    this.source = source
    this.blank = !source
    this.resize(width, height)
    this.startedAt = performance.now()
    this.lastFilmFrame = -1
    if (this.running) return
    this.running = true
    const loop = (now) => {
      if (!this.running) return
      this.render(now)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.source = null
  }

  // Blank leader before the camera is live.
  startBlank(width, height) {
    this.blank = true
    this.start(null, width, height)
  }
}

// A single still put through the same grade, used for the neighbouring frames
// on the strip so the whole roll matches.
export function developStill(img, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let projector
  try {
    projector = new FilmProjector(canvas)
  } catch {
    return null
  }
  projector.source = img
  projector.blank = false
  projector.resize(width, height)
  projector.startedAt = performance.now() - 5000 // past the run-up flare
  projector.lastFilmFrame = -1
  projector.render(performance.now())
  const url = canvas.toDataURL('image/jpeg', 0.86)
  projector.stop()
  return url
}
