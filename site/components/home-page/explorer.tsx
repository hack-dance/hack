"use client";

import { useEffect, useRef, useState } from "react";
import {
  createScene,
  hash01,
  type Kind,
  type NodeInfo,
  type SceneData,
  type SceneLink,
  type SceneNode,
} from "./scene";

/**
 * Fig. 2: one larger project. The file tree on the left picks what is lit in
 * the 3D model on the right, and the keys start, stop and re-point it.
 */

type Rows = NodeInfo["rows"];

interface Part {
  /** Final height. A remote floats and has none. */
  readonly H: number;
  /** A host helper: it runs on the machine, not in a container. */
  readonly host?: boolean;
  readonly id: string;
  readonly kind: Kind;
  /** A remote that is used only when db points at qa. */
  readonly qa?: boolean;
  readonly rows: Rows;
  /** The local service a remote is reached from. */
  readonly source?: string;
  /** Start-up wave: later waves rise later. */
  readonly wave: number;
  readonly x: number;
  readonly y?: number;
  readonly z: number;
}

const LOCAL = "local · hack engine";
const ON_HOST = "your machine, not a container";

function describe(
  kind: string,
  runs: string,
  address: string,
  from: string,
  extra: Rows = []
): Rows {
  return [
    ["kind", kind],
    ["runs", runs],
    ["address", address],
    ["from", from],
    ...extra,
  ];
}

function local(
  id: string,
  kind: Kind,
  at: readonly [x: number, z: number, H: number, wave: number],
  rows: Rows
): Part {
  return { H: at[2], id, kind, rows, wave: at[3], x: at[0], z: at[1] };
}

function remote(
  id: string,
  at: readonly [x: number, z: number, y: number],
  source: string,
  rows: Rows,
  qa = false
): Part {
  return {
    H: 0,
    id,
    kind: "remote",
    qa,
    rows,
    source,
    wave: 0,
    x: at[0],
    y: at[2],
    z: at[1],
  };
}

const PARTS: readonly Part[] = [
  local(
    "web",
    "screen",
    [-4.6, -2.6, 1.6, 2],
    describe("frontend", LOCAL, "https://storefront.hack.local", "apps/web", [
      ["needs", "api, auth"],
    ])
  ),
  local(
    "admin",
    "screen",
    [-3.0, -2.6, 1.3, 2],
    describe(
      "frontend",
      LOCAL,
      "https://admin.storefront.hack.local",
      "apps/admin",
      [["needs", "api, auth"]]
    )
  ),
  local(
    "api",
    "tower",
    [-1.0, -2.4, 2.1, 1],
    describe(
      "service",
      LOCAL,
      "https://api.storefront.hack.local",
      "apps/api",
      [["needs", "postgres, redis, billing api"]]
    )
  ),
  local(
    "auth",
    "tower",
    [0.8, -2.4, 1.4, 1],
    describe(
      "service",
      LOCAL,
      "auth:4100, inside the project",
      "services/auth",
      [["needs", "postgres, sso"]]
    )
  ),
  local(
    "search",
    "dish",
    [2.6, -2.4, 1.5, 1],
    describe(
      "search index",
      LOCAL,
      "search:7700, inside the project",
      "services/search"
    )
  ),
  local(
    "mail",
    "mail",
    [4.4, -2.4, 0.3, 1],
    describe(
      "mail catcher",
      LOCAL,
      "https://mail.storefront.hack.local",
      "image"
    )
  ),
  local(
    "worker",
    "gear",
    [-3.8, 0.2, 1.0, 2],
    describe("queue worker", LOCAL, "none (no route)", "services/jobs", [
      ["needs", "queue, object storage"],
    ])
  ),
  local(
    "scheduler",
    "clock",
    [-2.2, 0.2, 1.06, 2],
    describe("scheduler", LOCAL, "none (no route)", "services/jobs", [
      ["runs", "6 schedules"],
    ])
  ),
  local(
    "postgres",
    "disks",
    [0.4, 0.4, 1.2, 0],
    describe(
      "database",
      LOCAL,
      "db:5432, inside the project",
      "postgres:17 (image)"
    )
  ),
  local(
    "redis",
    "pyramid",
    [2.0, 0.4, 0.85, 0],
    describe(
      "cache",
      LOCAL,
      "redis:6379, inside the project",
      "redis:8 (image)"
    )
  ),
  local(
    "queue",
    "tube",
    [3.7, 0.4, 0.54, 0],
    describe("message queue", LOCAL, "queue:4222, inside the project", "image")
  ),
  {
    ...local(
      "sso",
      "plug",
      [-4.2, 3.2, 0.5, 0],
      describe("host helper", ON_HOST, "none", "lifecycle.before", [
        ["does", "checks the cloud sign-in before start"],
      ])
    ),
    host: true,
  },
  {
    ...local(
      "webhooks",
      "plug",
      [-2.4, 3.2, 0.5, 3],
      describe("host helper", ON_HOST, "forwards to api", "lifecycle.processes")
    ),
    host: true,
  },
  remote(
    "managed postgres",
    [1.6, 2.6, 3.0],
    "postgres",
    [
      ["kind", "remote database"],
      ["lives at", "$REMOTE_DB_HOST (encrypted)"],
      ["reached", "aws-ssm tunnel"],
      ["used when", "--use db=qa"],
    ],
    true
  ),
  remote("billing api", [-1.0, -4.6, 3.3], "api", [
    ["kind", "remote service"],
    ["lives at", "billing.internal"],
    ["reached", "vpn, this traffic only"],
    ["used when", "always: there is no local one"],
  ]),
  remote("object storage", [-5.4, 1.2, 2.9], "worker", [
    ["kind", "remote storage"],
    ["lives at", "a private bucket"],
    ["reached", "session tunnel"],
    ["used when", "always"],
  ]),
];

const POSTGRES_AT_QA: Rows = [
  ["kind", "database"],
  ["runs", "remote · managed postgres"],
  ["address", "db (same name) → tunnel"],
  ["because", "--use db=qa"],
];

const FILES: readonly { hint?: string; pick: string; text: string }[] = [
  { pick: "all", text: "storefront/" },
  { hint: "storefront", pick: "web", text: "├─ apps/web/            " },
  { hint: "back office", pick: "admin", text: "├─ apps/admin/          " },
  { hint: "graphql api", pick: "api", text: "├─ apps/api/            " },
  { pick: "auth", text: "├─ services/auth/" },
  { pick: "search", text: "├─ services/search/" },
  {
    hint: "worker, scheduler",
    pick: "worker,scheduler",
    text: "├─ services/jobs/       ",
  },
  { pick: "all", text: "└─ .hack/" },
  {
    hint: "the whole system",
    pick: "project",
    text: "   ├─ hack.config.json   ",
  },
  { hint: "settings", pick: "env", text: "   ├─ hack.env.default.yaml " },
  {
    hint: "what differs for qa",
    pick: "qa",
    text: "   ├─ hack.env.qa.yaml   ",
  },
  { hint: "yours", pick: "local", text: "   └─ hack.env.local.yaml " },
];

const NOTES: Readonly<Record<string, string>> = {
  all: "storefront/ · eleven services, three remotes and two host helpers, from one folder.",
  project:
    "hack.config.json · every service, what it needs, where each remote lives and how to reach it.",
  env: "hack.env.default.yaml · settings for every service, committed. Secrets are encrypted.",
  qa: "hack.env.qa.yaml · an overlay: the values that differ for qa. Pick it for one command with --env qa.",
  local:
    "hack.env.local.yaml · your own overrides, not committed. Everything local.",
  web: "apps/web · the storefront, at https://storefront.hack.local.",
  admin:
    "apps/admin · the back office, at https://admin.storefront.hack.local.",
  api: "apps/api · calls billing, which only exists remotely. Hack keeps that path open.",
  auth: "services/auth · sign-in for both frontends.",
  search: "services/search · its own index.",
  "worker,scheduler":
    "services/jobs · a worker and a scheduler. They write to object storage through a tunnel.",
};
const STOPPED_NOTE =
  "hack down · everything hack started is stopped. Data is kept.";

const KEYS = [
  { act: "up", label: "hack up" },
  { act: "qa", label: "hack up --use db=qa" },
  { act: "local", label: "everything local" },
  { act: "down", label: "hack down" },
] as const;

type Act = (typeof KEYS)[number]["act"];

/** The files that describe every local service but no remote or helper. */
const ENV_FILES = new Set(["env", "local", "qa"]);

function isLit(part: Part, pick: string): boolean {
  if (pick === "all" || pick === "project") {
    return true;
  }
  if (ENV_FILES.has(pick)) {
    return part.kind !== "remote" && !part.host;
  }
  const ids = pick.split(",");
  return (
    ids.includes(part.id) ||
    (part.kind === "remote" && ids.includes(part.source ?? ""))
  );
}

interface Model {
  /** Current height of each part, by id. */
  readonly h: Map<string, number>;
  mint: string;
  pick: string;
  pink: string;
  qa: boolean;
  state: "up" | "down";
  /** Height each part is growing or shrinking towards. */
  readonly t: Map<string, number>;
}

function isLive(part: Part, model: Model): boolean {
  return model.state === "up" && (!part.qa || model.qa);
}

function colorOf(part: Part, model: Model): string | null {
  if (part.kind === "remote") {
    return model.pink;
  }
  return part.host ? model.mint : null;
}

const PARTS_BY_ID = new Map(PARTS.map((part) => [part.id, part]));

function nodeFor(part: Part, model: Model): SceneNode {
  const isRemote = part.kind === "remote";
  const ghost = part.id === "postgres" && model.qa && model.state === "up";
  return {
    asleep: isRemote && !isLive(part, model),
    color: colorOf(part, model),
    dim: !isLit(part, model.pick),
    ghost,
    h: isRemote ? 1 : (model.h.get(part.id) ?? 0),
    id: part.id,
    info: { rows: ghost ? POSTGRES_AT_QA : part.rows, title: part.id },
    kind: part.kind,
    label: part.id,
    x: part.x,
    y: part.y,
    z: part.z,
  };
}

/** The tunnel to a remote in use, once the service it starts from has risen. */
function linkFor(part: Part, model: Model): SceneLink | null {
  if (!(part.kind === "remote" && isLive(part, model))) {
    return null;
  }
  const source = PARTS_BY_ID.get(part.source ?? "");
  const height = source ? (model.h.get(source.id) ?? 0) : 0;
  if (!source || height <= 0.1) {
    return null;
  }
  return {
    a: [source.x, height, source.z],
    alpha: isLit(part, model.pick) ? 1 : 0.3,
    b: [part.x, (part.y ?? 0) - 0.5, part.z],
    color: model.pink,
    id: part.id,
  };
}

function collect(model: Model): SceneData {
  const links: SceneLink[] = [];
  for (const part of PARTS) {
    const link = linkFor(part, model);
    if (link) {
      links.push(link);
    }
  }
  return { links, nodes: PARTS.map((part) => nodeFor(part, model)) };
}

function countText(model: Model): string {
  if (model.state !== "up") {
    return "stopped";
  }
  const locals = PARTS.filter(
    (part) =>
      part.kind !== "remote" &&
      !part.host &&
      !(part.id === "postgres" && model.qa)
  ).length;
  const remotes = PARTS.filter(
    (part) => part.kind === "remote" && isLive(part, model)
  ).length;
  return `${locals} local · ${remotes} remote · 2 host helpers`;
}

function noteFor(model: Model): string {
  return model.state === "down" ? STOPPED_NOTE : (NOTES[model.pick] ?? "");
}

interface ExplorerHandle {
  act: (act: Act) => void;
  destroy: () => void;
  pick: (pick: string) => void;
}

function startExplorer(
  dom: { canvas: HTMLCanvasElement; count: HTMLElement; scene: HTMLElement },
  ui: { setNote: (text: string) => void }
): ExplorerHandle {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const locals = PARTS.filter((part) => part.kind !== "remote");
  const model: Model = {
    h: new Map(locals.map((part) => [part.id, 0])),
    mint: "",
    pick: "all",
    pink: "",
    qa: false,
    state: "up",
    t: new Map(locals.map((part) => [part.id, 0])),
  };
  const rates = new Map(
    locals.map((part) => [part.id, 0.1 + hash01(part.id) * 0.12])
  );
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let destroyed = false;

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
    az: 0.46,
    calm,
    collect() {
      dom.count.textContent = countText(model);
      return collect(model);
    },
    cy: 0.6,
    drift: 0.0007,
    el: 0.5,
    fitH: 7,
    fitW: 13.5,
    repaint(css) {
      model.pink = css.getPropertyValue("--mg").trim();
      model.mint = css.getPropertyValue("--vi").trim();
    },
    step() {
      for (const [id, target] of model.t) {
        const height = model.h.get(id) ?? 0;
        const delta = target - height;
        model.h.set(
          id,
          Math.abs(delta) > 0.004
            ? height + delta * (rates.get(id) ?? 0.1)
            : target
        );
      }
    },
  });

  /** Starts every local part: at once, or in waves from the data stores up. */
  function start(instant: boolean): void {
    model.state = "up";
    for (const part of locals) {
      if (instant) {
        model.h.set(part.id, part.H);
        model.t.set(part.id, part.H);
        continue;
      }
      model.t.set(part.id, 0);
      model.h.set(part.id, Math.min(model.h.get(part.id) ?? 0, 0.02));
      later(
        () => model.t.set(part.id, part.H),
        140 + part.wave * 320 + hash01(`${part.id}d`) * 260
      );
    }
  }

  function stop(): void {
    model.state = "down";
    for (const part of locals) {
      model.t.set(part.id, 0);
      if (calm) {
        model.h.set(part.id, 0);
      }
    }
  }

  function refresh(): void {
    ui.setNote(noteFor(model));
    scene.draw();
  }

  start(calm);
  ui.setNote(noteFor(model));
  scene.run();

  return {
    act(key) {
      if (key === "down") {
        stop();
      } else {
        if (key !== "up") {
          model.qa = key === "qa";
        }
        if (key === "up" || model.state !== "up") {
          start(calm);
        }
      }
      refresh();
    },
    destroy() {
      destroyed = true;
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.clear();
      scene.destroy();
    },
    pick(pick) {
      model.pick = pick;
      refresh();
    },
  };
}

/** The parts of the model as a sentence, for a page without JavaScript. */
const PARTS_LIST = PARTS.map(
  (part) => `${part.id} (${part.rows[0]?.[1] ?? part.kind})`
).join(", ");

export function HomeExplorer() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  const handle = useRef<ExplorerHandle | null>(null);
  const [picked, setPicked] = useState(0);
  const [note, setNote] = useState(NOTES.all);

  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const count = countRef.current;
    if (!(scene && canvas && count)) {
      return;
    }
    setPicked(0);
    const started = startExplorer({ canvas, count, scene }, { setNote });
    handle.current = started;
    return () => {
      handle.current = null;
      started.destroy();
    };
  }, []);

  return (
    <div className="console figure-2">
      <div className="f2">
        {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons laid out as a file tree, not a form fieldset */}
        <div aria-label="Project files" className="tree" role="group">
          {FILES.map((file, position) => (
            <button
              aria-pressed={position === picked}
              key={file.text}
              onClick={() => {
                setPicked(position);
                handle.current?.pick(file.pick);
              }}
              type="button"
            >
              {file.text}
              {file.hint ? <i>{file.hint}</i> : null}
            </button>
          ))}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of a canvas and its captions, not a form fieldset */}
        <div
          aria-label="A 3D model of the project: frontends as slabs, services as towers, workers as stacks, data stores as cylinders, host helpers as flat pads, and remote services as diamonds reached through tunnels. Drag to rotate."
          className="scene"
          ref={sceneRef}
          role="group"
        >
          <canvas ref={canvasRef} />
          <noscript>
            <p className="nojs">
              This figure needs JavaScript. It draws the project as shapes on a
              grid, with a tunnel from a local service to each remote it uses:{" "}
              {PARTS_LIST}.
            </p>
          </noscript>
          <div className="hud tl micro">
            <b>fig. 2</b> &nbsp;storefront, one copy
            <br />
            <span className="hud-key">
              screen frontend · tower service · cogs worker · clock scheduler ·
              disks database · pyramid cache · pipe queue · plug host helper ·
              globe remote
            </span>
          </div>
          <div className="hud tr micro" ref={countRef} />
          <div className="hud br micro">
            drag to rotate · scroll to zoom · click a service
          </div>
        </div>
      </div>
      <div className="note">{note}</div>
      <div className="keys">
        {KEYS.map((key, position) => (
          <button
            key={key.act}
            onClick={() => handle.current?.act(key.act)}
            type="button"
          >
            <b>F{position + 1}</b>
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
