/** A small WebGL2 viewer for the simulated stock: drag to rotate, right-drag or Shift-drag to pan, wheel to zoom. */
import type { SimGrid } from './core/sim';

type M4 = number[];
const mul = (a: M4, b: M4): M4 => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function perspective(fov: number, asp: number, n: number, f: number): M4 {
  const t = 1 / Math.tan(fov / 2);
  return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0];
}
function lookAt(e: number[], c: number[], u: number[]): M4 {
  const nrm = (v: number[]) => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = nrm([c[0] - e[0], c[1] - e[1], c[2] - e[2]]), s = nrm(cross(f, u)), v = cross(s, f);
  return [s[0], v[0], -f[0], 0, s[1], v[1], -f[1], 0, s[2], v[2], -f[2], 0, -(s[0] * e[0] + s[1] * e[1] + s[2] * e[2]), -(v[0] * e[0] + v[1] * e[1] + v[2] * e[2]), f[0] * e[0] + f[1] * e[1] + f[2] * e[2], 1];
}

const VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec3 aCol;
uniform mat4 uMVP; uniform float uZ;
out vec3 vCol; out vec3 vNor;
void main(){ vec3 p = vec3(aPos.xy, aPos.z * uZ); gl_Position = uMVP * vec4(p, 1.0); vCol = aCol; vNor = aNor; }`;
const FS = `#version 300 es
precision mediump float;
in vec3 vCol; in vec3 vNor; out vec4 o;
void main(){ vec3 n = normalize(vNor); vec3 l = normalize(vec3(-0.45, -0.55, 0.7)); float d = max(dot(n, l), 0.0); o = vec4(vCol * (0.38 + 0.62 * d), 1.0); }`;

export class Viewer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private count = 0;
  private buffers: WebGLBuffer[] = [];
  private yaw = -Math.PI / 3; private pitch = 0.65; private dist = 200; private target = [0, 0, 0];
  private zScale = 1; private dirty = true; private dead = false;
  private size = { w: 100, h: 100, t: 10 };

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('This browser cannot show the 3D view (WebGL2 is needed).');
    this.gl = gl;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(this.prog, 0, 'aPos'); gl.bindAttribLocation(this.prog, 1, 'aNor'); gl.bindAttribLocation(this.prog, 2, 'aCol');
    gl.linkProgram(this.prog);
    let drag: { x: number; y: number; pan: boolean } | null = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const k = this.dist * 0.0015;
        this.target[0] += (-Math.sin(this.yaw) * dx - Math.cos(this.yaw) * Math.sin(this.pitch) * dy) * k * -1;
        this.target[1] += (Math.cos(this.yaw) * dx - Math.sin(this.yaw) * Math.sin(this.pitch) * dy) * k * -1;
      } else {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(0.02, Math.min(Math.PI / 2 - 0.001, this.pitch + dy * 0.008));
      }
      this.dirty = true;
    });
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.dist *= Math.exp(e.deltaY * 0.001); this.dirty = true; }, { passive: false });
    const loop = () => { if (this.dead) return; if (this.dirty) { this.dirty = false; this.render(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  setZScale(k: number) { this.zScale = k; this.dirty = true; }

  /** 'top' looks straight down with +Y up the screen; 'iso' is a three-quarter view; 'front' looks along +Y. */
  setView(p: 'iso' | 'top' | 'front') {
    if (p === 'top') { this.yaw = -Math.PI / 2; this.pitch = Math.PI / 2 - 0.001; }
    else if (p === 'front') { this.yaw = -Math.PI / 2; this.pitch = 0.12; }
    else { this.yaw = -Math.PI / 3; this.pitch = 0.65; }
    this.dist = Math.max(this.size.w, this.size.h) * 1.4;
    this.dirty = true;
  }

  /** Release everything this viewer holds on the GPU. The canvas's own listeners go when the canvas is replaced (see the Simulate button). */
  dispose() { this.dead = true; this.free(); this.gl.deleteProgram(this.prog); this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  private free() { for (const b of this.buffers) this.gl.deleteBuffer(b); this.buffers = []; if (this.vao) this.gl.deleteVertexArray(this.vao); this.vao = null; }

  /** Build the picture from a simulated grid (heights are pooled to a few hundred thousand cells at most). */
  setGrid(g: SimGrid) {
    const { nx, ny, cell, z, stock } = g;
    const k = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / 300000)));
    const mx = Math.ceil(nx / k), my = Math.ceil(ny / k);
    const H = new Float32Array(mx * my);
    for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
      let lo = 0;
      for (let b = j * k; b < Math.min(ny, (j + 1) * k); b++) for (let a = i * k; a < Math.min(nx, (i + 1) * k); a++) lo = Math.min(lo, z[b * nx + a]);
      H[j * mx + i] = lo;
    }
    const X = (i: number) => (i === 0 ? stock.x0 : i === mx - 1 ? stock.x0 + stock.w : stock.x0 + (i * k + k / 2) * cell);
    const Y = (j: number) => (j === 0 ? stock.y0 : j === my - 1 ? stock.y0 + stock.h : stock.y0 + (j * k + k / 2) * cell);
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
    const t = stock.t;
    for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) {
      const h = H[j * mx + i];
      const hl = H[j * mx + Math.max(0, i - 1)], hr = H[j * mx + Math.min(mx - 1, i + 1)];
      const hd = H[Math.max(0, j - 1) * mx + i], hu = H[Math.min(my - 1, j + 1) * mx + i];
      const sx = X(Math.min(mx - 1, i + 1)) - X(Math.max(0, i - 1)), sy = Y(Math.min(my - 1, j + 1)) - Y(Math.max(0, j - 1));
      const nxv = -(hr - hl) / (sx || 1), nyv = -(hu - hd) / (sy || 1), l = Math.hypot(nxv, nyv, 1);
      pos.push(X(i), Y(j), h); nor.push(nxv / l, nyv / l, 1 / l);
      if (h > -0.01) col.push(0.84, 0.69, 0.47);
      else if (h <= -t + 0.01) col.push(0.42, 0.44, 0.5);
      else { const d = Math.min(1, -h / t); col.push(0.66 - 0.3 * d, 0.47 - 0.26 * d, 0.29 - 0.18 * d); }
    }
    for (let j = 0; j < my - 1; j++) for (let i = 0; i < mx - 1; i++) {
      const a = j * mx + i, b = a + 1, c = a + mx, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
    // side walls down to the bottom of the stock
    const wall = (pts: [number, number, number][], nx2: number, ny2: number) => {
      const base = pos.length / 3;
      for (const [x, y, h] of pts) { pos.push(x, y, h, x, y, -t); nor.push(nx2, ny2, 0, nx2, ny2, 0); col.push(0.62, 0.48, 0.32, 0.5, 0.38, 0.25); }
      for (let q = 0; q < pts.length - 1; q++) { const a = base + q * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    };
    const row = (j: number) => Array.from({ length: mx }, (_, i): [number, number, number] => [X(i), Y(j), H[j * mx + i]]);
    const colm = (i: number) => Array.from({ length: my }, (_, j): [number, number, number] => [X(i), Y(j), H[j * mx + i]]);
    wall(row(0), 0, -1); wall(row(my - 1).reverse(), 0, 1); wall(colm(0).reverse(), -1, 0); wall(colm(mx - 1), 1, 0);
    // flip winding so walls face outward: handled by drawing without culling
    const gl = this.gl;
    this.free();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const attr = (loc: number, data: number[]) => { const b = gl.createBuffer()!; this.buffers.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0); };
    attr(0, pos); attr(1, nor); attr(2, col);
    const ib = gl.createBuffer()!; this.buffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    this.count = idx.length;
    this.size = { w: stock.w, h: stock.h, t };
    this.target = [stock.x0 + stock.w / 2, stock.y0 + stock.h / 2, -t / 2];
    this.setView('iso');
  }

  private render() {
    const gl = this.gl, c = this.canvas;
    const dpr = devicePixelRatio || 1, w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.93, 0.94, 0.96, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.vao || !this.count) return;
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    const cp = Math.cos(this.pitch), eye = [this.target[0] + this.dist * cp * Math.cos(this.yaw), this.target[1] + this.dist * cp * Math.sin(this.yaw), this.target[2] * this.zScale + this.dist * Math.sin(this.pitch)];
    const view = lookAt(eye, [this.target[0], this.target[1], this.target[2] * this.zScale], [0, 0, 1]);
    const proj = perspective(0.7, w / h, Math.max(0.5, this.dist * 0.01), this.dist * 20);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uMVP'), false, new Float32Array(mul(proj, view)));
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uZ'), this.zScale);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
  }
}
