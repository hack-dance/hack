"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { sample } from "@/lib/home-numbers";
import {
  createScene,
  hash01,
  type Kind,
  type NodeInfo,
  type SceneData,
  type SceneLink,
  type SceneNode,
  type ScenePad,
} from "./scene";
import { Term } from "./term";

/**
 * Fig. 1: a pretend terminal that drives a 3D view of one project's running
 * copies. Nothing here talks to a real hack; the commands only move the model.
 */

type Tone = "c0" | "c1" | "c2" | "c3" | "d" | "f" | "u";

interface Part {
  readonly href?: string;
  readonly id: number;
  readonly text: string;
  readonly tone?: Tone;
}

interface Line {
  readonly id: number;
  readonly parts: readonly Part[];
}

/** A piece of a line: plain text, toned text, or a link. */
type Piece = string | readonly [tone: Tone, text: string] | { href: string };

interface LegendItem {
  readonly name: string;
  readonly tone: Tone;
}

interface Copy {
  color: string;
  readonly cssVar: string;
  readonly dir: string;
  /** Current height of each service. */
  h: number[];
  readonly host: string;
  readonly name: string;
  readonly pos: readonly [x: number, z: number];
  /** Whether this copy's database points at the remote one. */
  remote: boolean;
  state: "none" | "up" | "asleep";
  /** Height each service is growing or shrinking towards. */
  t: number[];
  readonly tone: Tone;
}

const SERVICES: readonly {
  kind: Kind;
  name: string;
  src: string;
  what: string;
}[] = [
  { kind: "screen", name: "web", src: "./web (build)", what: "frontend" },
  { kind: "tower", name: "api", src: "./api (build)", what: "service" },
  { kind: "gear", name: "jobs", src: "./jobs (build)", what: "worker" },
  { kind: "disks", name: "db", src: "postgres:17 (image)", what: "database" },
];
const WEB = 0;
const API = 1;
const JOBS = 2;
const DB = 3;
const HEIGHTS = [1.7, 2.0, 0.95, 1.05];
const ASLEEP_HEIGHT = 0.12;
/** Where each service stands inside a copy's pad. */
const SLOTS = [
  [0.55, 0.5],
  [2.05, 0.5],
  [0.55, 2.0],
  [2.05, 2.0],
];
const REMOTE = { x: 5.4, y: 1.5, z: 2.2 };
const MAX_LINES = 80;
const NAME_WIDTH = 8;
const DETAIL_WIDTH = 14;
const BRANCH_WIDTH = 18;
const STATE_WIDTH = 8;
/** A later copy starts faster: the engine is up and the images are cached. */
const LATER_COPY_FACTOR = 0.6;
const INSTALL_PAGE = "/docs/v5/install";

const KEYS = [
  { label: "hack up", run: "hack up" },
  { label: "new worktree", run: "worktree" },
  { label: "status", run: "hack status" },
  { label: "timings", run: "hack up --timings" },
  { label: "hack use db=qa", run: "remote" },
  { label: "hack sleep", run: "hack sleep" },
];

const TIMING_BARS = [
  `engine  ███                    ${sample.engineReady.value}`,
  "plan    ░░                  skipped",
  "images  ░░                  skipped",
  `db         █████               ${sample.db.value}`,
  `api             ███████        ${sample.api.value}`,
  `jobs            ██████         ${sample.jobs.value}`,
  `web                    ██████  ${sample.web.value}`,
  "routes  ░░                  skipped",
];
const BAR_MARKS = /(█+|░+|skipped)/;

const HELP = [
  "hack up            start this copy",
  "hack up --timings  show where the time went",
  "hack status        list running copies",
  "hack use db=qa     point db at the remote one (or db=local)",
  "hack sleep         put this copy to sleep",
  "worktree           add a branch and start a copy of it",
  "clear",
];

const USE_DB = /^hack use db[= ](qa|remote|local)$/;
const HACK_UP = /^hack up\b/;
const GIT_WORKTREE_ADD = /^git worktree add\b/;
const ANY_HACK = /^hack\b/;

/** What the terminal shows when the page runs without JavaScript. */
const TRANSCRIPT = `<f>~/code/myapp $</f> <u>hack up</u>
<c0>✓</c0> engine  <d>ready         </d><f>${sample.engineReady.value}</f>
<c0>✓</c0> db      <d>postgres:17   </d><f>${sample.db.value}</f>
<c0>✓</c0> api     <d>healthy       </d><f>${sample.api.value}</f>
<c0>✓</c0> jobs    <d>running       </d><f>${sample.jobs.value}</f>
<c0>✓</c0> web     <d>healthy       </d><f>${sample.web.value}</f>
<c0>https://myapp.hack.local</c0>  <f>up in ${sample.warmStart.value} · hack engine</f>
<f>~/code/myapp $</f> <u>hack status</u>
<f>BRANCH            STATE   ADDRESS</f>
<c0>main              </c0>up      https://myapp.hack.local
<c1>fix-login         </c1>up      https://fix-login.myapp.hack.local  <f>db → remote</f>
<c2>agent/onboarding  </c2>up      https://agent-onboarding.myapp.hack.local
<c3>agent/checkout    </c3><f>asleep  </f>https://agent-checkout.myapp.hack.local`;

function makeCopies(): Copy[] {
  const copy = (
    name: string,
    dir: string,
    slug: string,
    look: readonly [cssVar: string, tone: Tone],
    pos: readonly [number, number]
  ): Copy => ({
    color: "",
    cssVar: look[0],
    dir,
    h: [0, 0, 0, 0],
    host: `${slug}myapp.hack.local`,
    name,
    pos,
    remote: false,
    state: "none",
    t: [0, 0, 0, 0],
    tone: look[1],
  });
  return [
    copy("main", "myapp", "", ["--cy", "c0"], [-6.2, 0.6]),
    copy(
      "fix-login",
      "myapp-fix-login",
      "fix-login.",
      ["--mg", "c1"],
      [-2.6, -3.9]
    ),
    copy(
      "agent/onboarding",
      "myapp-onboarding",
      "agent-onboarding.",
      ["--am", "c2"],
      [0.6, 1.0]
    ),
    copy(
      "agent/checkout",
      "myapp-checkout",
      "agent-checkout.",
      ["--vi", "c3"],
      [3.9, -3.2]
    ),
  ];
}

function addressOf(copy: Copy, service: number): string {
  if (service === WEB) {
    return `https://${copy.host}`;
  }
  if (service === API) {
    return `https://api.${copy.host}`;
  }
  return service === DB ? "db:5432, inside this copy only" : "none (no route)";
}

function stateOf(copy: Copy, far: boolean): string {
  if (copy.state === "asleep") {
    return "asleep · memory returned";
  }
  return far ? `tunnel up · ${sample.tunnelLatency.value}` : "healthy";
}

function infoFor(copy: Copy, service: number): NodeInfo {
  const { name, src, what } = SERVICES[service];
  const far = copy.remote && service === DB;
  return {
    rows: [
      ["kind", what],
      ["runs", far ? "remote · managed postgres" : "local · hack engine"],
      ["address", far ? "db (same name) → tunnel" : addressOf(copy, service)],
      ["from", far ? "$REMOTE_DB_HOST, aws-ssm tunnel" : src],
      ["state", stateOf(copy, far)],
    ],
    title: `${name} · ${copy.name}`,
  };
}

function remoteNode(copies: readonly Copy[], inUse: boolean): SceneNode {
  const users = copies
    .filter((copy) => copy.remote)
    .map((copy) => copy.name)
    .join(", ");
  return {
    asleep: !inUse,
    h: 1,
    id: "remote",
    info: {
      rows: [
        ["kind", "remote database"],
        ["lives at", "$REMOTE_DB_HOST (encrypted)"],
        ["reached", "aws-ssm tunnel"],
        ["sign-in", "cloud, checked before start"],
        ["used by", inUse ? users : "nobody right now"],
      ],
      title: "managed postgres",
    },
    kind: "remote",
    label: "managed postgres",
    sub: inUse ? "remote · tunnel up" : "remote · not in use",
    x: REMOTE.x,
    y: REMOTE.y,
    z: REMOTE.z,
  };
}

function collect(copies: readonly Copy[]): SceneData {
  const nodes: SceneNode[] = [];
  const pads: ScenePad[] = [];
  const links: SceneLink[] = [];
  for (const copy of copies) {
    if (copy.state === "none") {
      continue;
    }
    const asleep = copy.state === "asleep";
    pads.push({
      color: copy.color,
      dim: asleep,
      label: copy.name + (asleep ? "  asleep" : ""),
      s: 3.3,
      x: copy.pos[0] - 0.35,
      z: copy.pos[1] - 0.35,
    });
    for (const [service, slot] of SLOTS.entries()) {
      const far = copy.remote && service === DB && !asleep;
      const x = copy.pos[0] + slot[0];
      const z = copy.pos[1] + slot[1];
      nodes.push({
        asleep,
        color: far ? null : copy.color,
        ghost: far,
        h: copy.h[service],
        id: `${copy.name}/${SERVICES[service].name}`,
        info: infoFor(copy, service),
        kind: SERVICES[service].kind,
        x,
        z,
      });
      if (far) {
        links.push({
          a: [x, Math.max(copy.h[DB], 0.1), z],
          b: [REMOTE.x, REMOTE.y - 0.5, REMOTE.z],
          color: copy.color,
          id: copy.name,
        });
      }
    }
  }
  nodes.push(remoteNode(copies, links.length > 0));
  return { links, nodes, pads };
}

/** Each service eases towards its target height at its own pace. */
function stepHeights(copies: readonly Copy[]): void {
  for (const copy of copies) {
    for (let i = 0; i < copy.h.length; i++) {
      const delta = copy.t[i] - copy.h[i];
      if (Math.abs(delta) > 0.004) {
        copy.h[i] += delta * (0.1 + hash01(copy.name + i) * 0.12);
      } else {
        copy.h[i] = copy.t[i];
      }
    }
  }
}

function angleText(az: number, el: number, zoom: number): string {
  const degrees = ((((az * 180) / Math.PI) % 360) + 360) % 360;
  const azimuth = String(Math.round(degrees)).padStart(3, "0");
  return `az ${azimuth}° el ${Math.round((el * 180) / Math.PI)}° ×${zoom.toFixed(1)}`;
}

function toParts(pieces: readonly Piece[]): Part[] {
  return pieces.map((piece, id) => {
    if (typeof piece === "string") {
      return { id, text: piece };
    }
    if ("href" in piece) {
      return { href: piece.href, id, text: `hack.foo${piece.href}` };
    }
    return { id, text: piece[1], tone: piece[0] };
  });
}

interface ConsoleUi {
  readonly setCwd: (text: string) => void;
  readonly setLegend: (items: LegendItem[]) => void;
  readonly setLines: (update: (lines: Line[]) => Line[]) => void;
}

interface ConsoleDom {
  readonly angle: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLInputElement;
  readonly out: HTMLElement;
  readonly scene: HTMLElement;
}

interface ConsoleHandle {
  destroy: () => void;
  /** Runs a command the reader typed or pressed a key for. */
  run: (command: string) => void;
  /** Stops the scripted intro; the reader has taken over. */
  takeOver: () => void;
}

type Step = readonly [delayMs: number, run: () => void];

function startConsole(dom: ConsoleDom, ui: ConsoleUi): ConsoleHandle {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const copies = makeCopies();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let here = 0;
  let engine = false;
  let busy = false;
  let auto = !calm;
  let destroyed = false;
  let lineId = 0;

  function later(run: () => void, ms: number): void {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) {
        run();
      }
    }, ms);
    timers.add(id);
  }

  const scene = createScene(dom.scene, dom.canvas, {
    angle(az, el, zoom) {
      dom.angle.textContent = angleText(az, el, zoom);
    },
    az: 0.5,
    calm,
    collect: () => collect(copies),
    cy: 0.56,
    drift: 0.0009,
    el: 0.52,
    fitH: 7.4,
    fitW: 16.5,
    repaint(css) {
      for (const copy of copies) {
        copy.color = css.getPropertyValue(copy.cssVar).trim();
      }
    },
    step: () => stepHeights(copies),
  });

  // Keep the newest line in view, as a terminal does.
  const follow = new MutationObserver(() => {
    dom.out.scrollTop = dom.out.scrollHeight;
  });
  follow.observe(dom.out, { childList: true });

  function legend(): void {
    ui.setLegend(
      copies
        .filter((copy) => copy.state !== "none")
        .map((copy) => ({ name: copy.name, tone: copy.tone }))
    );
  }

  function say(...pieces: Piece[]): void {
    lineId += 1;
    const line = { id: lineId, parts: toParts(pieces) };
    ui.setLines((lines) => [...lines, line].slice(-MAX_LINES));
  }

  function prompt(): string {
    return `~/code/${copies[here].dir} $`;
  }

  function echo(command: string): void {
    say(["f", prompt()], " ", ["u", command]);
  }

  /** Runs the steps one after another, each after its own delay. */
  function sequence(steps: readonly Step[], done?: () => void): void {
    let i = 0;
    busy = true;
    const next = (): void => {
      if (i >= steps.length) {
        busy = false;
        ui.setCwd(prompt());
        done?.();
        return;
      }
      const [delay, run] = steps[i];
      i += 1;
      later(() => {
        run();
        next();
      }, delay);
    };
    next();
  }

  function report(copy: Copy, name: string, detail: string, took: string) {
    say(
      [copy.tone, "✓"],
      ` ${name.padEnd(NAME_WIDTH)}`,
      ["d", detail.padEnd(DETAIL_WIDTH)],
      ["f", took]
    );
  }

  function coldStart(copy: Copy, done?: () => void): void {
    const first = !engine;
    const factor = first ? 1 : LATER_COPY_FACTOR;
    const took = (figure: { value: string }): string =>
      `${(Number.parseFloat(figure.value) * factor).toFixed(1)}s`;
    const services: readonly [string, number, string, string][] = [
      ["db", DB, "postgres:17", took(sample.db)],
      ["api", API, "healthy", took(sample.api)],
      ["jobs", JOBS, "running", took(sample.jobs)],
      ["web", WEB, "healthy", took(sample.web)],
    ];
    copy.state = "up";
    legend();
    const steps: Step[] = [
      first
        ? [
            260,
            () => {
              engine = true;
              report(copy, "engine", "ready", sample.engineReady.value);
            },
          ]
        : [
            120,
            () =>
              report(
                copy,
                "engine",
                "already up",
                sample.engineAlreadyUp.value
              ),
          ],
      ...services.map(
        ([name, service, detail, time]): Step => [
          first ? 300 : 190,
          () => {
            copy.t[service] = HEIGHTS[service];
            report(copy, name, detail, time);
          },
        ]
      ),
      [
        200,
        () => {
          const total = first ? sample.warmStart : sample.secondCopy;
          say([copy.tone, `https://${copy.host}`], "  ", [
            "f",
            `up in ${total.value} · hack engine`,
          ]);
        },
      ],
    ];
    sequence(steps, done);
  }

  function up(copy: Copy, done?: () => void): void {
    if (copy.state === "up") {
      sequence(
        [
          [
            220,
            () =>
              say([copy.tone, "✓"], " nothing changed ", [
                "f",
                `· 5 steps skipped · ${sample.nothingChanged.value}`,
              ]),
          ],
        ],
        done
      );
      return;
    }
    if (copy.state === "asleep") {
      sequence(
        [
          [
            380,
            () => {
              copy.state = "up";
              copy.t = [...HEIGHTS];
              say([copy.tone, "✓"], " awake ", ["f", `· ${sample.wake.value}`]);
              say([copy.tone, `https://${copy.host}`]);
            },
          ],
        ],
        done
      );
      return;
    }
    coldStart(copy, done);
  }

  function status(): void {
    say([
      "f",
      `${"BRANCH".padEnd(BRANCH_WIDTH)}${"STATE".padEnd(STATE_WIDTH)}ADDRESS`,
    ]);
    const running = copies.filter((copy) => copy.state !== "none");
    for (const copy of running) {
      say(
        [copy.tone, copy.name.padEnd(BRANCH_WIDTH)],
        copy.state === "up"
          ? "up".padEnd(STATE_WIDTH)
          : ["f", "asleep".padEnd(STATE_WIDTH)],
        `https://${copy.host}`,
        ...(copy.remote ? (["  ", ["f", "db → remote"]] as const) : [])
      );
    }
    if (running.length === 0) {
      say(["f", "nothing running. try: hack up"]);
    }
  }

  function timings(): void {
    const tone = copies[here].tone;
    for (const row of TIMING_BARS) {
      say(
        ...row
          .split(BAR_MARKS)
          .filter((text) => text !== "")
          .map((text): Piece => {
            if (text.startsWith("█")) {
              return [tone, text];
            }
            return BAR_MARKS.test(text) ? ["f", text] : text;
          })
      );
    }
    say([
      "f",
      `        ├─────────┼─────────┤  ${sample.warmStart.value} · 3 skipped · 2 together`,
    ]);
  }

  function worktree(done?: () => void): void {
    const next = copies.find((copy) => copy.state === "none");
    if (!next || next === copies[0]) {
      echo("git worktree add");
      say([
        "f",
        next
          ? "start main first: hack up"
          : "four copies is enough for a demo. try: hack status",
      ]);
      done?.();
      return;
    }
    echo(
      `git worktree add ../${next.dir} -b ${next.name} && cd ../${next.dir} && hack up`
    );
    here = copies.indexOf(next);
    up(next, done);
  }

  function switchDb(target: string): void {
    const copy = copies[here];
    const to = target === "local" ? "local" : "qa";
    copy.remote = to === "qa";
    if (copy.state !== "up") {
      say([copy.tone, "✓"], ` db → ${to} `, [
        "f",
        "· saved for this checkout · applies on the next up",
      ]);
    } else if (to === "qa") {
      say([copy.tone, "✓"], " db → qa ", [
        "f",
        `· tunnel up · api restarted · ${sample.useRemote.value}`,
      ]);
    } else {
      say([copy.tone, "✓"], " db → local ", [
        "f",
        `· tunnel closed · api restarted · ${sample.useLocal.value}`,
      ]);
    }
  }

  function sleep(): void {
    const copy = copies[here];
    if (copy.state !== "up") {
      say(["f", "this copy is not running"]);
      return;
    }
    copy.state = "asleep";
    copy.t = copy.t.map(() => ASLEEP_HEIGHT);
    say([copy.tone, "✓"], " asleep ", [
      "f",
      `· ${sample.sleep.value} · memory returned`,
    ]);
  }

  /** Commands that answer at once. Returns false for one it does not know. */
  function instant(command: string): boolean {
    const use = USE_DB.exec(command);
    if (command === "help") {
      for (const row of HELP) {
        say(["d", row]);
      }
    } else if (command === "clear") {
      ui.setLines(() => []);
    } else if (command === "hack status") {
      status();
    } else if (use) {
      switchDb(use[1]);
    } else if (command === "hack sleep") {
      sleep();
    } else {
      return false;
    }
    return true;
  }

  function unknown(command: string): void {
    if (ANY_HACK.test(command)) {
      say(["f", "not in this demo. the real one is one page away: "], {
        href: INSTALL_PAGE,
      });
    } else {
      say(["f", `${command.split(" ")[0]}: try a hack command, or help`]);
    }
  }

  function run(input: string, done?: () => void): void {
    const typed = input.trim();
    if (!typed) {
      done?.();
      return;
    }
    if (busy) {
      return;
    }
    if (typed === "worktree") {
      worktree(done);
      return;
    }
    const command =
      typed === "remote"
        ? `hack use db=${copies[here].remote ? "local" : "qa"}`
        : typed;
    echo(command);
    if (command === "hack up --timings") {
      if (copies[here].state === "up") {
        timings();
        done?.();
      } else {
        up(copies[here], () => {
          timings();
          done?.();
        });
      }
      return;
    }
    if (HACK_UP.test(command)) {
      up(copies[here], done);
      return;
    }
    if (GIT_WORKTREE_ADD.test(command)) {
      worktree(done);
      return;
    }
    if (!instant(command)) {
      unknown(command);
    }
    done?.();
  }

  /** Types a command into the prompt, a key at a time, then runs it. */
  function typeOut(command: string, done: () => void): void {
    let i = 0;
    dom.input.value = "";
    const key = (): void => {
      if (!auto) {
        dom.input.value = "";
        return;
      }
      if (i < command.length) {
        dom.input.value += command[i];
        i += 1;
        later(key, 55);
        return;
      }
      later(() => {
        dom.input.value = "";
        run(command, done);
      }, 260);
    };
    key();
  }

  function intro(): void {
    const script = ["hack up", "worktree", "remote"];
    const pauses = [1100, 1300];
    const play = (position: number): void => {
      if (!auto) {
        return;
      }
      typeOut(script[position], () => {
        if (position + 1 < script.length) {
          later(() => play(position + 1), pauses[position]);
        } else {
          auto = false;
        }
      });
    };
    later(() => play(0), 900);
  }

  ui.setLines(() => []);
  ui.setCwd(prompt());
  legend();
  scene.run();
  if (auto) {
    intro();
  } else {
    say(["f", "a pretend terminal. try hack up, or the keys below."]);
  }

  return {
    destroy() {
      destroyed = true;
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
      follow.disconnect();
      scene.destroy();
      dom.input.value = "";
    },
    run: (command) => run(command),
    takeOver() {
      if (auto) {
        auto = false;
        dom.input.value = "";
      }
    },
  };
}

function renderPart(part: Part) {
  if (part.href) {
    return (
      <Link href={part.href} key={part.id}>
        {part.text}
      </Link>
    );
  }
  return part.tone ? (
    <span className={part.tone} key={part.id}>
      {part.text}
    </span>
  ) : (
    part.text
  );
}

export function HomeConsole() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const angleRef = useRef<HTMLDivElement>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const handle = useRef<ConsoleHandle | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [legend, setLegend] = useState<LegendItem[]>([]);
  const [cwd, setCwd] = useState("~/code/myapp $");

  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const angle = angleRef.current;
    const out = outRef.current;
    const input = inputRef.current;
    if (!(scene && canvas && angle && out && input)) {
      return;
    }
    const started = startConsole(
      { angle, canvas, input, out, scene },
      { setCwd, setLegend, setLines }
    );
    handle.current = started;
    return () => {
      handle.current = null;
      started.destroy();
    };
  }, []);

  const press = (command: string) => {
    handle.current?.takeOver();
    handle.current?.run(command);
  };

  return (
    <div className="console">
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of a canvas and its captions, not a form fieldset */}
      <div
        aria-label="A 3D view of one project: each running copy is a cluster of four towers, one per service. Run commands below to start, add and sleep copies. Drag to rotate."
        className="scene"
        ref={sceneRef}
        role="group"
      >
        <canvas ref={canvasRef} />
        <noscript>
          <p className="nojs">
            This figure needs JavaScript. It draws each running copy of myapp as
            four shapes on a grid: a screen for web, a tower for api, cogs for
            jobs and disks for db, with a tunnel from a copy to the remote
            database it uses.
          </p>
        </noscript>
        <div className="hud tl micro">
          <b>fig. 1</b> &nbsp;myapp, running copies
          <br />
          <span className="hud-key">
            screen web · tower api · cogs jobs · disks db · globe remote
          </span>
        </div>
        <div className="hud tr micro" ref={angleRef}>
          az 000° el 00°
        </div>
        <div className="hud bl micro">
          {legend.map((item) => (
            <span className={item.tone} key={item.name}>
              {item.name}
            </span>
          ))}
        </div>
        <div className="hud br micro">
          drag to rotate · scroll to zoom · click a service
        </div>
      </div>
      <div className="term">
        <div aria-live="polite" className="out" ref={outRef}>
          <noscript>
            <Term>{TRANSCRIPT}</Term>
          </noscript>
          {lines.map((line) => (
            <div key={line.id}>
              {line.parts.length > 0 ? line.parts.map(renderPart) : " "}
            </div>
          ))}
        </div>
        <label className="prompt">
          <span>{cwd}</span>
          <input
            aria-label="Try a hack command"
            autoCapitalize="off"
            autoComplete="off"
            onKeyDown={(event) => {
              handle.current?.takeOver();
              if (event.key === "Enter") {
                const command = event.currentTarget.value;
                event.currentTarget.value = "";
                handle.current?.run(command);
              }
            }}
            onPointerDown={() => handle.current?.takeOver()}
            placeholder="type a command, or use the keys below"
            ref={inputRef}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="keys">
        {KEYS.map((key, position) => (
          <button key={key.run} onClick={() => press(key.run)} type="button">
            <b>F{position + 1}</b>
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
