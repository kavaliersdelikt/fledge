// A real-time Schwarzschild black hole: one light ray per pixel is integrated through curved space-time, so the shadow,
// the lensed back of the accretion disk, the photon ring and the smeared stars all come out of the physics.
// Units: Schwarzschild radius = 1. No dependencies; WebGL2 only.

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCam;      // camera position
uniform vec2 uShift;    // screen-space offset of the hole (in units of screen height)
uniform float uRoll;
uniform float uQuality; // 0..1, number of integration steps

const float DISK_IN = 2.6;
const float DISK_OUT = 13.0;
const int MAX_STEPS = 260;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
                 mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
                 mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

// Disk colour ramp in the Fledge palette: violet (cool) -> magenta -> peach -> white-blue (hot).
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.4);
  vec3 c0 = vec3(0.16, 0.03, 0.42);
  vec3 c1 = vec3(0.62, 0.18, 0.95);
  vec3 c2 = vec3(1.00, 0.45, 0.70);
  vec3 c3 = vec3(1.00, 0.80, 0.62);
  vec3 c4 = vec3(0.80, 0.92, 1.00);
  if (t < 0.3) return mix(c0, c1, t / 0.3);
  if (t < 0.6) return mix(c1, c2, (t - 0.3) / 0.3);
  if (t < 0.85) return mix(c2, c3, (t - 0.6) / 0.25);
  return mix(c3, c4, clamp((t - 0.85) / 0.4, 0.0, 1.0));
}

vec3 stars(vec3 d) {
  vec3 col = vec3(0.0);
  // Star size is tied to the on-screen pixel size so stars stay round points at any render resolution.
  // Stars live on a cube-face grid (2D cells, star kept inside its cell) so none is clipped into a streak.
  float px = 0.65 / uRes.y;
  vec3 ad = abs(d);
  vec2 fuv; float face;
  if (ad.x >= ad.y && ad.x >= ad.z) { fuv = d.yz / ad.x; face = d.x > 0.0 ? 0.0 : 1.0; }
  else if (ad.y >= ad.z) { fuv = d.xz / ad.y; face = d.y > 0.0 ? 2.0 : 3.0; }
  else { fuv = d.xy / ad.z; face = d.z > 0.0 ? 4.0 : 5.0; }
  float faceScale = 1.0 / (1.0 + dot(fuv, fuv) * 0.5); // rough angular size of a face unit here
  for (int layer = 0; layer < 3; layer++) {
    float scale = layer == 0 ? 26.0 : (layer == 1 ? 60.0 : 130.0);
    float keep = layer == 0 ? 0.93 : (layer == 1 ? 0.9 : 0.93);
    vec2 g = fuv * scale;
    vec2 id = floor(g);
    vec3 h = hash33(vec3(id, face * 13.0 + float(layer) * 101.0));
    if (h.x > keep) {
      vec2 c = 0.3 + 0.4 * hash33(vec3(id, face + 7.0)).xy;
      float dist = length(fract(g) - c) / scale * faceScale;
      float size = px * (0.8 + 1.4 * h.y) * (layer == 0 ? 1.5 : 1.0);
      float b = exp(-dist * dist / (size * size)) * (layer == 0 ? 2.2 : 0.9) * (0.3 + 1.6 * pow(h.z, 4.0));
      float tw = 0.75 + 0.25 * sin(uTime * (1.0 + 3.0 * h.y) + h.z * 40.0);
      vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.75), h.y);
      col += tint * b * tw;
    }
  }
  return col;
}

vec3 background(vec3 d) {
  // A tilted galactic band with violet and sky nebulae.
  vec3 axis = normalize(vec3(0.25, 1.0, -0.35));
  float band = exp(-pow(dot(d, axis) * 3.2, 2.0));
  float n = fbm(d * 2.4 + vec3(0.0, 0.0, uTime * 0.004));
  float n2 = fbm(d * 5.0 - 3.0);
  vec3 neb = mix(vec3(0.20, 0.06, 0.45), vec3(0.03, 0.30, 0.55), smoothstep(0.35, 0.75, n2));
  vec3 col = neb * pow(n, 2.6) * (0.22 + 1.2 * band);
  col += vec3(0.9, 0.85, 1.0) * pow(max(n2 - 0.35, 0.0), 2.0) * band * 0.35; // dust glow
  col += stars(d) * (0.6 + 0.8 * band);
  return col;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y - uShift;
  float cr = cos(uRoll), sr = sin(uRoll);
  uv = mat2(cr, -sr, sr, cr) * uv;

  vec3 ro = uCam;
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.55 + uv.x * rt + uv.y * up);

  vec3 p = ro;
  vec3 v = rd;
  vec3 hv = cross(p, v);
  float h2 = dot(hv, hv);

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  bool captured = false;
  float minR = 1e9;
  float glow = 0.0;
  int steps = int(mix(110.0, float(MAX_STEPS), uQuality));

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= steps) break;
    float r2 = dot(p, p);
    float r = sqrt(r2);
    minR = min(minR, r);
    if (r < 1.0) { captured = true; break; }
    if (r > 40.0 && dot(p, v) > 0.0) break;

    float dt = clamp(0.085 * (r - 0.85) * (r - 0.85) + 0.012, 0.012, 1.6);
    vec3 acc = -1.5 * h2 * p / (r2 * r2 * r);
    v += acc * dt;
    vec3 np = p + v * dt;

    // Soft haze around the disk plane (a thick, faint corona).
    float rr0 = length(p.xz);
    if (rr0 > DISK_IN * 0.8 && rr0 < DISK_OUT * 1.3) {
      float prof = exp(-abs(p.y) * 3.0) * smoothstep(DISK_OUT * 1.3, DISK_IN, rr0) / (rr0 * rr0);
      glow += prof * dt;
    }

    if (p.y * np.y < 0.0) {
      vec3 hit = mix(p, np, p.y / (p.y - np.y));
      float rr = length(hit.xz);
      if (rr > DISK_IN && rr < DISK_OUT) {
        float phi = atan(hit.z, hit.x);
        float omega = 1.6 / pow(rr, 1.5);
        float a = phi + omega * uTime;
        vec3 q = vec3(cos(a) * 2.2, sin(a) * 2.2, rr * 3.2);
        float streak = fbm(q + vec3(0.0, 0.0, -uTime * 0.05));
        float fine = fbm(vec3(cos(a) * 6.0, sin(a) * 6.0, rr * 9.0));
        float dens = smoothstep(0.25, 0.85, streak) * (0.55 + 0.45 * fine);

        // Shakura-Sunyaev-like flux profile.
        float flux = (1.0 - sqrt(DISK_IN / rr)) / pow(rr / DISK_IN, 3.0);
        float temp = pow(flux * 9.0, 0.25);

        // Relativistic Doppler beaming and gravitational redshift.
        vec3 vel = normalize(vec3(-hit.z, 0.0, hit.x));
        float beta = 0.72 * sqrt(0.5 / (rr - 1.0));
        float gamma = inversesqrt(1.0 - beta * beta);
        float cosT = dot(vel, -normalize(v));
        float g = 1.0 / (gamma * (1.0 - beta * cosT)) * sqrt(1.0 - 1.0 / rr);
        float boost = pow(g, 3.2);

        float edge = smoothstep(DISK_IN, DISK_IN + 0.35, rr) * smoothstep(DISK_OUT, DISK_OUT - 4.5, rr);
        vec3 c = ramp(temp * g * 0.95) * (flux * 26.0 + 0.10) * boost * (0.35 + 1.4 * dens);
        float aDisk = clamp(edge * (0.35 + 0.65 * dens) * 0.92, 0.0, 1.0);
        col += (1.0 - alpha) * c * aDisk;
        alpha += (1.0 - alpha) * aDisk;
        if (alpha > 0.985) break;
      }
    }
    p = np;
  }

  // At this camera distance true lensing stretches every star across the frame into a dash. Keep the full bend near the
  // hole (Einstein ring, photon ring) and soften it in the far field, as film renders of black holes do.
  float lensW = smoothstep(16.0, 2.6, minR);
  lensW *= lensW;
  vec3 bgDir = normalize(mix(rd, normalize(v), lensW));
  if (!captured) col += (1.0 - alpha) * background(bgDir);
  col += vec3(0.55, 0.32, 1.0) * glow * 0.55 * (1.0 - alpha * 0.6);
  // Photon ring highlight for rays that skimmed r = 1.5.
  if (!captured) col += vec3(0.75, 0.65, 1.0) * 0.012 / (abs(minR - 1.5) + 0.012) * 0.18;

  col = aces(col * 1.15);
  col = pow(col, vec3(0.92));
  // Vignette and grain.
  vec2 sv = gl_FragCoord.xy / uRes - 0.5;
  col *= 1.0 - 0.55 * dot(sv, sv);
  col += (hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5) * 0.018;
  outColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  return s;
}

/**
 * Start rendering into `canvas`. Returns a controller, or null when WebGL2 is not available.
 * state: { scroll: 0..1, mx, my: -1..1 } is read every frame.
 */
export function startBlackHole(canvas, state, { still = false } = {}) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) return null;

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
  } catch (e) {
    console.warn('[fledge] black hole disabled:', e);
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(['uRes', 'uTime', 'uCam', 'uShift', 'uRoll', 'uQuality'].map((n) => [n, gl.getUniformLocation(prog, n)]));

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Render scale relative to CSS pixels; adapted to the measured frame time.
  let scale = Math.min(0.75, 1.0 / dpr) * dpr;
  const minScale = 0.3, maxScale = Math.min(1.25, dpr);
  let quality = 1.0;
  let frames = 0, acc = 0, last = performance.now(), t0 = last;
  let running = true, raf = 0, held = false;
  const cam = { yaw: 0, pitch: 0, dist: 0, mx: 0, my: 0 };
  let intro = still ? 1 : 0;

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;

    // Adapt resolution every 24 frames.
    if (!still) {
      acc += dt; frames++;
      if (frames >= 24) {
        const ms = (acc / frames) * 1000;
        if (ms > 24 && scale > minScale) { scale = Math.max(minScale, scale * 0.82); quality = Math.max(0.35, quality - 0.15); }
        else if (ms < 13 && scale < maxScale) { scale = Math.min(maxScale, scale * 1.08); quality = Math.min(1, quality + 0.1); }
        frames = 0; acc = 0;
      }
    }
    resize();

    // Camera: an intro dolly, mouse parallax and scroll-driven tilt.
    intro = Math.min(1, intro + dt / 3.2);
    const ease = 1 - Math.pow(1 - intro, 3);
    const s = state.scroll;
    cam.mx += (state.mx - cam.mx) * Math.min(1, dt * 2.5);
    cam.my += (state.my - cam.my) * Math.min(1, dt * 2.5);
    const yaw = 0.55 + cam.mx * 0.22 + time * 0.012;
    const pitch = 0.085 + ease * 0.02 + s * 0.55 + cam.my * 0.06;
    const dist = 44 - ease * 21 + s * 5;
    const pos = [Math.cos(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.sin(yaw) * Math.cos(pitch) * dist];

    const wide = canvas.clientWidth / canvas.clientHeight;
    const shiftX = wide > 1.25 ? Math.min(0.5, (wide - 1.0) * 0.52) * (1 - s * 0.7) : 0;
    const shiftY = wide > 1.25 ? 0 : 0.12;

    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uTime, still ? 12.0 : time);
    gl.uniform3f(u.uCam, pos[0], pos[1], pos[2]);
    gl.uniform2f(u.uShift, shiftX, shiftY);
    gl.uniform1f(u.uRoll, -0.12 + cam.mx * 0.03);
    gl.uniform1f(u.uQuality, quality);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (running && !still) raf = requestAnimationFrame(frame);
  }

  const onVis = () => {
    if (document.hidden) { running = false; cancelAnimationFrame(raf); }
    else if (!running && !still && !held) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('resize', () => { if (still) requestAnimationFrame(frame); });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; canvas.dispatchEvent(new CustomEvent('blackhole-lost')); });

  raf = requestAnimationFrame(frame);
  return {
    get scale() { return scale; },
    redraw() { requestAnimationFrame(frame); },
    pause() { held = true; running = false; cancelAnimationFrame(raf); },
    // Also used to opt in to animation when the page started as a still frame (reduced motion).
    resume() {
      held = false; still = false;
      if (document.hidden) return;
      cancelAnimationFrame(raf);
      running = true; last = performance.now(); raf = requestAnimationFrame(frame);
    },
  };
}
