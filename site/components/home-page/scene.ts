/**
 * A small wireframe 3D renderer on a 2D canvas, shared by the two homepage
 * figures. It draws a floor grid, a silhouette per kind of service, tunnels
 * between a local service and a remote one, and a tooltip for the service
 * under the pointer.
 *
 * The caller owns the model: `collect()` returns what to draw each frame and
 * `step()` advances it. The scene owns the camera (drag to rotate, wheel to
 * zoom), hover (after a short delay), click to pin, and every listener, timer,
 * observer and animation frame it starts. `destroy()` releases all of them, so
 * a component can create a scene in an effect and tear it down in cleanup.
 */

const TAU = 6.2832;
/** Distance from the camera to the origin, in model units. */
const CAMERA = 19;
const HOVER_DELAY_MS = 320;
const CLICK_SLOP_PX = 5;
const MAX_PIXEL_RATIO = 2;
const LABELS_MIN_WIDTH = 560;
const TUNNEL_RADIUS = 0.17;
const TUNNEL_SIDES = 10;
const BITS_PER_PACKET = 8;

export type Kind =
  | "screen"
  | "tower"
  | "gear"
  | "clock"
  | "disks"
  | "pyramid"
  | "tube"
  | "dish"
  | "mail"
  | "plug"
  | "remote";

export type Vec3 = readonly [x: number, y: number, z: number];

export interface NodeInfo {
  readonly rows: readonly (readonly [name: string, value: string])[];
  readonly title: string;
}

export interface SceneNode {
  readonly asleep?: boolean;
  /** `null` or absent draws in the ink colour. */
  readonly color?: string | null;
  readonly dim?: boolean;
  /** Drawn dashed: the service is not running here. */
  readonly ghost?: boolean;
  /** Current height. A remote ignores it. */
  readonly h: number;
  readonly id: string;
  readonly info?: NodeInfo;
  readonly kind: Kind;
  readonly label?: string;
  readonly sub?: string;
  readonly x: number;
  /** Height of a remote's centre above the floor. */
  readonly y?: number;
  readonly z: number;
}

export interface ScenePad {
  readonly color: string;
  readonly dim?: boolean;
  readonly label: string;
  /** Side length. */
  readonly s: number;
  readonly x: number;
  readonly z: number;
}

export interface SceneLink {
  readonly a: Vec3;
  readonly alpha?: number;
  readonly b: Vec3;
  readonly color: string;
  readonly id: string;
}

export interface SceneData {
  readonly links?: readonly SceneLink[];
  readonly nodes: readonly SceneNode[];
  readonly pads?: readonly ScenePad[];
}

export interface SceneOptions {
  /** Called with the camera each time the scene draws. */
  readonly angle?: (az: number, el: number, zoom: number) => void;
  readonly az: number;
  /** No drift, no draw-in, traffic frozen: reduced motion. */
  readonly calm: boolean;
  readonly collect: () => SceneData;
  /** Where the floor's origin sits, as a fraction of the height. */
  readonly cy: number;
  /** Radians of rotation per frame while nobody drags. */
  readonly drift?: number;
  readonly el: number;
  /** Model units that must fit across and down the canvas. */
  readonly fitH: number;
  readonly fitW: number;
  /** Called at start and whenever the theme changes, before a redraw. */
  readonly repaint?: (css: CSSStyleDeclaration) => void;
  /** Advances the model by one frame. */
  readonly step?: () => void;
}

export interface SceneHandle {
  destroy: () => void;
  draw: () => void;
  /** Starts the animation loop. */
  run: () => void;
}

/** A stable pseudo-random number in [0, 1) for a name (FNV-1a). */
export function hash01(text: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a mixes with xor
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: reads the hash as unsigned
  return ((h >>> 0) % 10_000) / 10_000;
}

type Point = [x: number, y: number, depth: number];
type Floor = readonly (readonly [x: number, z: number])[];
type Box = [left: number, top: number, right: number, bottom: number];

interface Style {
  /** Overall opacity. */
  a: number;
  color: string;
  dash: number[] | null;
  /** Hovered or pinned. */
  hot: boolean;
}

interface Hit {
  box: Box;
  node: SceneNode;
}

function rect(cx: number, cz: number, sx: number, sz: number): Floor {
  return [
    [cx - sx / 2, cz - sz / 2],
    [cx + sx / 2, cz - sz / 2],
    [cx + sx / 2, cz + sz / 2],
    [cx - sx / 2, cz + sz / 2],
  ];
}

function ngon(cx: number, cz: number, r: number, n: number, rot = 0): Floor {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

function cog(
  cx: number,
  cz: number,
  outer: number,
  inner: number,
  teeth: number,
  rot: number
): Floor {
  const out: [number, number][] = [];
  const n = teeth * 4;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const r = i % 4 < 2 ? outer : inner;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function fillFactor(style: Style): number {
  return (style.dash ? 0.15 : 1) * (style.hot ? 2.4 : 1) * style.a;
}

function dashFor(node: SceneNode): number[] | null {
  if (node.ghost) {
    return [4, 3];
  }
  return node.asleep ? [2, 3] : null;
}

function opacityFor(node: SceneNode): number {
  if (node.dim) {
    return 0.28;
  }
  return node.asleep ? 0.5 : 1;
}

/** A quadratic curve from `a` to `b` that rises a little above both. */
function curve(a: Vec3, b: Vec3): (t: number) => Vec3 {
  const m: Vec3 = [
    (a[0] + b[0]) / 2,
    Math.max(a[1], b[1]) + 0.25,
    (a[2] + b[2]) / 2,
  ];
  return (t) => {
    const u = 1 - t;
    return [
      u * u * a[0] + 2 * u * t * m[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * m[1] + t * t * b[1],
      u * u * a[2] + 2 * u * t * m[2] + t * t * b[2],
    ];
  };
}

/** A point on the curve and two unit vectors across it. */
function frameAt(
  at: (t: number) => Vec3,
  t: number
): readonly [Vec3, Vec3, Vec3] {
  const p = at(t);
  const f = at(Math.min(t + 0.02, 1));
  const g = at(Math.max(t - 0.02, 0));
  const raw = [f[0] - g[0], f[1] - g[1], f[2] - g[2]];
  const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  const T = [raw[0] / length, raw[1] / length, raw[2] / length];
  const flat = Math.hypot(T[2], T[0]);
  const A: Vec3 = flat < 0.01 ? [1, 0, 0] : [T[2] / flat, 0, -T[0] / flat];
  const B: Vec3 = [
    T[1] * A[2] - T[2] * A[1],
    T[2] * A[0] - T[0] * A[2],
    T[0] * A[1] - T[1] * A[0],
  ];
  return [p, A, B];
}

function tooltipKey(info: NodeInfo, pinned: boolean): string {
  return JSON.stringify([info.title, info.rows, pinned]);
}

function fillTooltip(tip: HTMLElement, info: NodeInfo, pinned: boolean): void {
  const title = document.createElement("b");
  title.textContent = info.title;
  const cells = info.rows.flatMap((row) =>
    row.map((text) => {
      const cell = document.createElement("span");
      cell.textContent = text;
      return cell;
    })
  );
  tip.replaceChildren(title, ...cells);
  if (!pinned) {
    const hint = document.createElement("i");
    hint.textContent = "click to pin";
    tip.append(hint);
  }
}

const INERT: SceneHandle = {
  destroy: () => undefined,
  draw: () => undefined,
  run: () => undefined,
};

export function createScene(
  el: HTMLElement,
  canvas: HTMLCanvasElement,
  o: SceneOptions
): SceneHandle {
  const context = canvas.getContext("2d");
  if (!context) {
    return INERT;
  }
  const ctx = context;

  let W = 0;
  let H = 0;
  let az = o.az;
  let elv = o.el;
  let zoom = 1;
  let drag = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;
  let mx = -1;
  let my = -1;
  let hover: string | null = null;
  let hoverWas: string | null = null;
  let hoverAt = 0;
  let pinned: string | null = null;
  let hits: Hit[] = [];
  let bounds: Box | null = null;
  let running = false;
  let visible = true;
  let destroyed = false;
  let frame = 0;
  let tipKey = "";
  let colors = { ink: "", line: "", mono: "monospace" };
  /** When each tunnel started to draw itself in. */
  const born = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new AbortController();

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  el.append(tip);

  function later(run: () => void, ms: number): void {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) {
        run();
      }
    }, ms);
    timers.add(id);
  }

  function paint(): void {
    const css = getComputedStyle(el);
    colors = {
      ink: css.getPropertyValue("--ink").trim(),
      line: css.getPropertyValue("--line").trim(),
      mono: css.fontFamily || "monospace",
    };
    o.repaint?.(css);
  }

  function size(): void {
    const r = el.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    W = r.width;
    H = r.height;
    canvas.width = W * ratio;
    canvas.height = H * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** Projects a model point to the canvas, and grows the open hit box. */
  function P(x: number, y: number, z: number): Point {
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    const ce = Math.cos(elv);
    const se = Math.sin(elv);
    const x1 = x * ca - z * sa;
    const z1 = x * sa + z * ca;
    const y2 = y * ce + z1 * se;
    const z2 = -y * se + z1 * ce;
    const k =
      (Math.min(W / o.fitW, H / o.fitH) * zoom * CAMERA) / (CAMERA + z2);
    const p: Point = [W / 2 + x1 * k, H * o.cy - y2 * k, z2];
    if (bounds) {
      bounds[0] = Math.min(bounds[0], p[0]);
      bounds[1] = Math.min(bounds[1], p[1]);
      bounds[2] = Math.max(bounds[2], p[0]);
      bounds[3] = Math.max(bounds[3], p[1]);
    }
    return p;
  }

  function line(a: Point, b: Point): void {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }

  function poly(points: readonly Point[]): void {
    ctx.beginPath();
    for (const [i, p] of points.entries()) {
      if (i === 0) {
        ctx.moveTo(p[0], p[1]);
      } else {
        ctx.lineTo(p[0], p[1]);
      }
    }
    ctx.closePath();
  }

  function pen(S: Style): void {
    ctx.strokeStyle = S.color;
    ctx.fillStyle = S.color;
    ctx.lineWidth = S.hot ? 1.5 : 1;
    ctx.setLineDash(S.dash ?? []);
  }

  function penUp(): void {
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  /** The two upright edges of a round shape, at its left and right. */
  function silhouette(lo: readonly Point[], hi: readonly Point[]): void {
    let left = 0;
    let right = 0;
    for (const [k, p] of lo.entries()) {
      if (p[0] < lo[left][0]) {
        left = k;
      }
      if (p[0] > lo[right][0]) {
        right = k;
      }
    }
    line(lo[left], hi[left]);
    line(lo[right], hi[right]);
  }

  /**
   * Extrudes a floor outline from `y0` to `y1`. A `top` under 1 tapers it and
   * over 1 flares it; `round` skips the upright edges.
   */
  function ext(
    ring: Floor,
    y0: number,
    y1: number,
    S: Style,
    round = false,
    top = 1
  ): void {
    const n = ring.length;
    let cx = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p[0] / n;
      cz += p[1] / n;
    }
    const lo = ring.map((p) => P(p[0], y0, p[1]));
    const hi = ring.map((p) =>
      P(cx + (p[0] - cx) * top, y1, cz + (p[1] - cz) * top)
    );
    const f = fillFactor(S);
    pen(S);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      poly([lo[i], lo[j], hi[j], hi[i]]);
      ctx.globalAlpha = 0.05 * f;
      ctx.fill();
      if (!round) {
        ctx.globalAlpha = 0.9 * S.a;
        ctx.stroke();
      }
    }
    poly(hi);
    ctx.globalAlpha = 0.15 * f;
    ctx.fill();
    ctx.globalAlpha = 0.9 * S.a;
    ctx.stroke();
    if (round) {
      poly(lo);
      ctx.stroke();
      silhouette(lo, hi);
    }
    penUp();
  }

  function loop(ring: Floor, y: number, S: Style): void {
    ctx.strokeStyle = S.color;
    ctx.globalAlpha = 0.9 * S.a;
    ctx.setLineDash(S.dash ?? []);
    poly(ring.map((p) => P(p[0], y, p[1])));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function seg(a: Vec3, b: Vec3, S: Style): void {
    ctx.strokeStyle = S.color;
    ctx.globalAlpha = 0.9 * S.a;
    line(P(a[0], a[1], a[2]), P(b[0], b[1], b[2]));
  }

  /** A ring standing upright, facing along the x or the z axis. */
  function vring(centre: Vec3, r: number, axis: "x" | "z", n: number): Point[] {
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      out.push(
        axis === "x"
          ? P(centre[0], centre[1] + s, centre[2] + c)
          : P(centre[0] + c, centre[1] + s, centre[2])
      );
    }
    return out;
  }

  function face(points: readonly Point[], S: Style, fill: number): void {
    pen(S);
    poly(points);
    if (fill) {
      ctx.globalAlpha = fill * fillFactor(S);
      ctx.fill();
    }
    ctx.globalAlpha = 0.9 * S.a;
    ctx.stroke();
    penUp();
  }

  function globe(n: SceneNode, S: Style): void {
    const r = 0.55;
    const cy = n.y ?? 0;
    ctx.strokeStyle = S.color;
    ctx.setLineDash(S.dash ?? []);
    ctx.lineWidth = S.hot ? 1.5 : 1;
    for (const latitude of [-0.7, 0, 0.7]) {
      const y = cy + Math.sin(latitude) * r;
      const rr = Math.cos(latitude) * r;
      poly(ngon(n.x, n.z, rr, 20).map((p) => P(p[0], y, p[1])));
      ctx.globalAlpha = 0.85 * S.a;
      ctx.stroke();
    }
    for (const meridian of [0, 1.047, 2.094]) {
      const points: Point[] = [];
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * TAU;
        points.push(
          P(
            n.x + Math.cos(a) * r * Math.cos(meridian),
            cy + Math.sin(a) * r,
            n.z + Math.cos(a) * r * Math.sin(meridian)
          )
        );
      }
      poly(points);
      ctx.globalAlpha = 0.6 * S.a;
      ctx.stroke();
      if (S.hot && meridian === 0) {
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = S.color;
        ctx.fill();
      }
    }
    penUp();
  }

  /** One silhouette per kind of thing, after the icons in architecture diagrams. */
  const SHAPES: Record<Kind, (n: SceneNode, S: Style) => void> = {
    // frontend: a screen on a post
    screen(n, S) {
      const h = n.h;
      const y = h * 0.38;
      ext(rect(n.x, n.z, 0.5, 0.34), 0, 0.05, S);
      ext(rect(n.x, n.z, 0.1, 0.1), 0.05, y, S);
      ext(rect(n.x, n.z, 1.24, 0.09), y, h, S);
      if (h > 0.7) {
        loop(rect(n.x, n.z, 1.24, 0.09), y + (h - y) * 0.82, S);
      }
    },
    // service: a stepped tower
    tower(n, S) {
      const h = n.h;
      ext(rect(n.x, n.z, 0.88, 0.88), 0, h * 0.45, S);
      ext(rect(n.x, n.z, 0.62, 0.62), h * 0.45, h * 0.8, S);
      ext(rect(n.x, n.z, 0.34, 0.34), h * 0.8, h, S);
    },
    // worker: two cogs on an axle
    gear(n, S) {
      const h = n.h;
      ext(cog(n.x, n.z, 0.62, 0.46, 8, 0), 0, h * 0.26, S);
      ext(ngon(n.x, n.z, 0.14, 10), h * 0.26, h * 0.5, S, true);
      ext(cog(n.x, n.z, 0.44, 0.32, 6, 0.3), h * 0.5, h * 0.74, S);
      ext(ngon(n.x, n.z, 0.1, 10), h * 0.74, h, S, true);
    },
    // scheduler: a clock face standing up
    clock(n, S) {
      const r = clamp((n.h - 0.06) / 2, 0.05, 0.5);
      const cy = 0.06 + r;
      ext(rect(n.x, n.z, 0.56, 0.24), 0, 0.06, S);
      face(vring([n.x, cy, n.z], r, "z", 24), S, 0.1);
      if (r > 0.3) {
        seg([n.x, cy, n.z], [n.x, cy + r * 0.7, n.z], S);
        seg([n.x, cy, n.z], [n.x + r * 0.5, cy, n.z], S);
      }
    },
    // database: stacked disks
    disks(n, S) {
      const c = ngon(n.x, n.z, 0.5, 22);
      const s = n.h / 3;
      for (let i = 0; i < 3; i++) {
        ext(c, i * s, i * s + s * 0.7, S, true);
      }
    },
    // cache: a pyramid
    pyramid(n, S) {
      ext(rect(n.x, n.z, 1.0, 1.0), 0, 0.05, S);
      ext(rect(n.x, n.z, 0.9, 0.9), 0.05, Math.max(n.h, 0.07), S, false, 0.02);
    },
    // queue: a pipe lying on its side
    tube(n, S) {
      const r = clamp(n.h * 0.5, 0.05, 0.27);
      const cy = r + 0.06;
      const rings = [-0.66, -0.22, 0.22, 0.66];
      for (const [i, dx] of rings.entries()) {
        const capped = i === 0 || i === rings.length - 1;
        face(vring([n.x + dx, cy, n.z], r, "x", 16), S, capped ? 0.1 : 0);
      }
      for (const [dy, dz] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        seg(
          [n.x - 0.66, cy + dy, n.z + dz],
          [n.x + 0.66, cy + dy, n.z + dz],
          S
        );
      }
    },
    // search: a dish on a mast
    dish(n, S) {
      const h = n.h;
      ext(rect(n.x, n.z, 0.5, 0.5), 0, 0.05, S);
      ext(rect(n.x, n.z, 0.12, 0.12), 0.05, h * 0.55, S);
      ext(ngon(n.x, n.z, 0.1, 16), h * 0.55, h, S, true, 5.6);
    },
    // mail: an envelope
    mail(n, S) {
      const h = n.h;
      ext(rect(n.x, n.z, 1.0, 0.68), 0, h, S);
      seg([n.x - 0.5, h, n.z - 0.34], [n.x, h, n.z + 0.05], S);
      seg([n.x + 0.5, h, n.z - 0.34], [n.x, h, n.z + 0.05], S);
    },
    // host helper: a plug
    plug(n, S) {
      ext(ngon(n.x, n.z, 0.56, 6), 0, 0.1, S);
      if (n.h > 0.14) {
        ext(rect(n.x - 0.17, n.z, 0.1, 0.1), 0.1, n.h, S);
        ext(rect(n.x + 0.17, n.z, 0.1, 0.1), 0.1, n.h, S);
      }
    },
    // remote: a globe
    remote: globe,
  };

  /** Records when a tunnel first appears, with a stable stagger per tunnel. */
  function birth(link: SceneLink, now: number): number {
    const known = born.get(link.id);
    if (known !== undefined) {
      return known;
    }
    const at = o.calm ? Number.NEGATIVE_INFINITY : now + hash01(link.id) * 420;
    born.set(link.id, at);
    return at;
  }

  /** Forgets tunnels that are gone, so they draw in again when they return. */
  function reap(links: readonly SceneLink[]): void {
    const live = new Set(links.map((link) => link.id));
    for (const id of born.keys()) {
      if (!live.has(id)) {
        born.delete(id);
      }
    }
  }

  /**
   * Traffic in one direction: 8-bit packets. Read a lane's packets in order,
   * as ASCII, for its message.
   */
  function lane(options: {
    alpha: number;
    at: (t: number) => Vec3;
    dir: 1 | -1;
    index: number;
    length: number;
    message: string;
    seed: number;
    speed: number;
    time: number;
  }): void {
    const { alpha, at, dir, index, length, message, seed, speed, time } =
      options;
    const packets = Math.max(1, Math.floor(length / 1.9));
    const gap = 0.125 / length;
    for (let j = 0; j < packets; j++) {
      const u = time * speed + j / packets + seed * (index + 1);
      const order = Math.floor(u) * packets - j;
      const head = u - Math.floor(u);
      const position =
        ((order % message.length) + message.length) % message.length;
      const bits = message
        .charCodeAt(position)
        .toString(2)
        .padStart(BITS_PER_PACKET, "0");
      for (let k = 0; k < BITS_PER_PACKET; k++) {
        const t = head - k * gap;
        if (t < 0.04 || t > 0.96) {
          continue;
        }
        const [centre, across] = frameAt(at, dir > 0 ? t : 1 - t);
        const off = dir * 0.07;
        const p = P(
          centre[0] + across[0] * off,
          centre[1] + across[1] * off,
          centre[2] + across[2] * off
        );
        ctx.globalAlpha = Math.min(1, Math.min(t, 1 - t) * 14) * alpha;
        ctx.fillText(bits[k], p[0], p[1]);
      }
    }
  }

  /** A tunnel. It draws itself in, then carries bits both ways. */
  function link(L: SceneLink, now: number): void {
    const { a, b } = L;
    const seed = hash01(L.id);
    const at = curve(a, b);
    const progress = clamp((now - birth(L, now)) / (620 + seed * 500), 0, 1);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) + 0.3;
    const alpha = L.alpha ?? 1;
    const rings = Math.max(6, Math.round(length * 2.4));
    let previous: Point[] | null = null;
    ctx.strokeStyle = L.color;
    ctx.fillStyle = L.color;
    ctx.setLineDash([]);
    for (let i = 0; i <= rings; i++) {
      if (i / rings > progress) {
        break;
      }
      const [centre, A, B] = frameAt(at, i / rings);
      const ring: Point[] = [];
      for (let k = 0; k < TUNNEL_SIDES; k++) {
        const c = Math.cos((k / TUNNEL_SIDES) * TAU) * TUNNEL_RADIUS;
        const s = Math.sin((k / TUNNEL_SIDES) * TAU) * TUNNEL_RADIUS;
        ring.push(
          P(
            centre[0] + A[0] * c + B[0] * s,
            centre[1] + A[1] * c + B[1] * s,
            centre[2] + A[2] * c + B[2] * s
          )
        );
      }
      poly(ring);
      ctx.globalAlpha = 0.34 * alpha;
      ctx.stroke();
      if (previous) {
        ctx.globalAlpha = 0.2 * alpha;
        line(previous[0], ring[0]);
        line(previous[5], ring[5]);
      }
      previous = ring;
    }
    if (progress < 1) {
      return;
    }
    ctx.font = `9px ${colors.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const time = o.calm ? 3.1 : now / 1000;
    const shared = { alpha, at, length, seed, time };
    lane({
      ...shared,
      dir: 1,
      index: 0,
      message: "HACK THE PLANET ",
      speed: (0.78 + seed * 0.1) / length,
    });
    lane({
      ...shared,
      dir: -1,
      index: 1,
      message: "ONE FILE RUNS ANYWHERE ",
      speed: (0.68 + seed * 0.1) / length,
    });
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  function showTip(hit: Hit, x: number, y: number): void {
    const info = hit.node.info;
    if (!info) {
      tip.hidden = true;
      return;
    }
    const isPinned = pinned === hit.node.id;
    const key = tooltipKey(info, isPinned);
    if (key !== tipKey) {
      tipKey = key;
      fillTooltip(tip, info, isPinned);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${clamp(x + 16, 8, Math.max(8, W - tw - 8))}px`;
    tip.style.top = `${clamp(y - th / 2, 8, Math.max(8, H - th - 8))}px`;
  }

  function drawGrid(): void {
    ctx.strokeStyle = colors.line;
    for (let i = -6; i <= 6; i++) {
      ctx.globalAlpha = i % 3 === 0 ? 0.9 : 0.45;
      line(P(i, 0, -5), P(i, 0, 5));
      if (i >= -5 && i <= 5) {
        line(P(-6, 0, i), P(6, 0, i));
      }
    }
  }

  function drawPad(pad: ScenePad): void {
    ctx.strokeStyle = pad.color;
    ctx.setLineDash([1, 3]);
    ctx.globalAlpha = 0.5;
    poly([
      P(pad.x, 0, pad.z),
      P(pad.x + pad.s, 0, pad.z),
      P(pad.x + pad.s, 0, pad.z + pad.s),
      P(pad.x, 0, pad.z + pad.s),
    ]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (W > LABELS_MIN_WIDTH) {
      const at = P(pad.x, 0, pad.z + pad.s);
      ctx.fillStyle = pad.color;
      ctx.globalAlpha = pad.dim ? 0.6 : 1;
      ctx.fillText(pad.label, at[0] + 2, at[1] + 6);
    }
  }

  function drawLabel(n: SceneNode, S: Style, box: Box): void {
    if (!(n.label && W > LABELS_MIN_WIDTH)) {
      return;
    }
    ctx.fillStyle = S.color;
    ctx.globalAlpha = (S.hot ? 1 : 0.6) * (n.dim ? 0.5 : 1);
    if (n.kind === "remote") {
      ctx.fillText(n.label, box[2] + 8, box[1] + 4);
      if (n.sub) {
        ctx.globalAlpha *= 0.6;
        ctx.fillText(n.sub, box[2] + 8, box[1] + 18);
      }
      return;
    }
    ctx.textAlign = "center";
    const at = P(n.x, 0, n.z + 0.72);
    ctx.fillText(n.label, at[0], at[1] + 4);
    ctx.textAlign = "left";
  }

  function drawNode(n: SceneNode): void {
    const S: Style = {
      a: opacityFor(n),
      color: n.color || colors.ink,
      dash: dashFor(n),
      hot: n.id === hover || n.id === pinned,
    };
    const box: Box = [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    bounds = box;
    if (n.kind !== "remote" && n.h < 0.05) {
      ext(rect(n.x, n.z, 0.8, 0.8), 0, 0.02, S);
    } else {
      SHAPES[n.kind](n, S);
    }
    bounds = null;
    hits.push({ box, node: n });
    drawLabel(n, S, box);
  }

  /** The nearest service under the pointer that has something to say. */
  function hitUnderPointer(): Hit | null {
    if (mx < 0 || drag) {
      return null;
    }
    for (let j = hits.length - 1; j >= 0; j--) {
      const { box, node } = hits[j];
      const inside =
        mx >= box[0] - 3 &&
        mx <= box[2] + 3 &&
        my >= box[1] - 3 &&
        my <= box[3] + 3;
      if (node.info && inside) {
        return hits[j];
      }
    }
    return null;
  }

  function cursorFor(hit: Hit | null): string {
    if (drag) {
      return "grabbing";
    }
    return hit ? "pointer" : "grab";
  }

  function updateHover(now: number): void {
    const hit = hitUnderPointer();
    hover = hit ? hit.node.id : null;
    el.style.cursor = cursorFor(hit);
    const pin = pinned
      ? (hits.find((candidate) => candidate.node.id === pinned) ?? null)
      : null;
    if (hover !== hoverWas) {
      hoverWas = hover;
      hoverAt = now;
      if (hover && !running) {
        later(again, HOVER_DELAY_MS + 20);
      }
    }
    if (hit && (now - hoverAt >= HOVER_DELAY_MS || hit.node.id === pinned)) {
      showTip(hit, mx, my);
    } else if (pin && !hit) {
      showTip(pin, pin.box[2], (pin.box[1] + pin.box[3]) / 2);
    } else {
      tip.hidden = true;
    }
  }

  function draw(now: number = performance.now()): void {
    if (destroyed) {
      return;
    }
    o.angle?.(az, elv, zoom);
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    bounds = null;
    drawGrid();
    const data = o.collect();
    ctx.font = `10px ${colors.mono}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (const pad of data.pads ?? []) {
      drawPad(pad);
    }
    hits = [];
    // Farthest first, so nearer services draw over the ones behind them.
    const byDepth = data.nodes
      .map((n) => ({ depth: P(n.x, 0, n.z)[2] - (n.y ?? 0), node: n }))
      .sort((a, b) => b.depth - a.depth);
    for (const { node } of byDepth) {
      drawNode(node);
    }
    const links = data.links ?? [];
    for (const L of links) {
      link(L, now);
    }
    reap(links);
    ctx.globalAlpha = 1;
    updateHover(now);
  }

  /**
   * Draws twice when the loop is not running: the first pass finds what is
   * under the pointer and the second draws it highlighted.
   */
  function again(): void {
    draw();
    if (!running) {
      draw();
    }
  }

  function loopFrame(now: number): void {
    if (destroyed) {
      return;
    }
    o.step?.();
    if (!(drag || o.calm)) {
      az += o.drift ?? 0;
    }
    if (visible) {
      draw(now);
    } else {
      // Off screen: keep the model and the tunnels' clocks moving, skip the pixels.
      const links = o.collect().links ?? [];
      for (const L of links) {
        birth(L, now);
      }
      reap(links);
    }
    frame = requestAnimationFrame(loopFrame);
  }

  function track(event: PointerEvent): void {
    const r = el.getBoundingClientRect();
    mx = event.clientX - r.left;
    my = event.clientY - r.top;
  }

  const { signal } = listeners;
  el.addEventListener(
    "pointerdown",
    (event) => {
      drag = true;
      moved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      track(event);
      el.setPointerCapture(event.pointerId);
    },
    { signal }
  );
  el.addEventListener(
    "pointermove",
    (event) => {
      track(event);
      if (drag) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        az += dx * 0.006;
        elv = clamp(elv + dy * 0.004, 0.2, 1.15);
        lastX = event.clientX;
        lastY = event.clientY;
      }
      if (!running) {
        again();
      }
    },
    { signal }
  );
  el.addEventListener(
    "pointerup",
    () => {
      const click = moved < CLICK_SLOP_PX;
      drag = false;
      if (click) {
        if (!running) {
          draw();
        }
        pinned = hover && hover !== pinned ? hover : null;
      }
      if (!running) {
        again();
      }
    },
    { signal }
  );
  el.addEventListener(
    "pointercancel",
    () => {
      drag = false;
    },
    { signal }
  );
  el.addEventListener(
    "pointerleave",
    () => {
      mx = -1;
      if (!running) {
        again();
      }
    },
    { signal }
  );
  el.addEventListener(
    "wheel",
    (event) => {
      const next = clamp(zoom * Math.exp(-event.deltaY * 0.0016), 0.6, 2.6);
      if (next === zoom) {
        return;
      }
      event.preventDefault();
      zoom = next;
      if (!running) {
        again();
      }
    },
    { passive: false, signal }
  );

  const resize = new ResizeObserver(() => {
    size();
    again();
  });
  resize.observe(el);

  const onScreen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      visible = entry.isIntersecting;
    }
  });
  onScreen.observe(el);

  // The theme is a class on <html>; the canvas colours come from CSS.
  const theme = new MutationObserver(() => {
    paint();
    again();
  });
  theme.observe(document.documentElement, {
    attributeFilter: ["class", "style"],
    attributes: true,
  });

  // Labels are drawn in the page's font, which may arrive after first paint.
  document.fonts?.addEventListener("loadingdone", again, { signal });
  document.fonts?.ready.then(() => {
    if (!destroyed) {
      paint();
      again();
    }
  });

  paint();
  size();

  return {
    destroy() {
      destroyed = true;
      running = false;
      cancelAnimationFrame(frame);
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
      listeners.abort();
      resize.disconnect();
      onScreen.disconnect();
      theme.disconnect();
      tip.remove();
      el.style.cursor = "";
    },
    draw: again,
    run() {
      if (running || destroyed) {
        return;
      }
      running = true;
      frame = requestAnimationFrame(loopFrame);
    },
  };
}
