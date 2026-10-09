import { spyOn } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../../src/lib/native-compose-adoption-generation.ts";
import { parseLegacyComposeAdoptionReceipt } from "../../src/lib/native-compose-adoption-receipt.ts";
import { runLegacyComposeRetainedRoutingOperation } from "../../src/lib/native-compose-adoption-routing-execution.ts";
import * as engine from "../../src/lib/native-compose-engine-identity.ts";
import * as ownership from "../../src/lib/native-compose-ownership.ts";
import { mapLegacyNativeRetainedRouting } from "../../src/lib/native-config-import-plan.ts";
import type { NativeRoutingResolution } from "../../src/lib/native-routing-plan-protocol.ts";
import * as shell from "../../src/lib/shell.ts";
import { restoreEnv } from "./env.ts";

export const ROUTING_CANARY = "synthetic-retained-sql-row";
export const ROUTING_IDS = {
  db: "a".repeat(64),
  web: "b".repeat(64),
  network: "c".repeat(64),
  ingress: "d".repeat(64),
  proxy: "e".repeat(64),
  foreign: "f".repeat(64),
};
const CREATED = "2026-01-01T01:02:03Z",
  HASH = "1".repeat(64),
  GROUP = 987_654;
const LABELS = {
  caddy: "original.hack.local,original.hack.gy",
  "caddy.reverse_proxy": "{{upstreams 3000}}",
  "caddy.tls": "internal",
};
const LIST_FORMATS: Readonly<Record<string, string>> = {
  container:
    '{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "com.docker.compose.project")}}}',
  network:
    '{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}',
  volume:
    '{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}',
};
function refuse(): never {
  throw new Error(
    "Synthetic retained route transport refused; values omitted."
  );
}
function identity(value: unknown) {
  if (
    !(
      isRecord(value) &&
      typeof value.dev === "number" &&
      typeof value.ino === "number"
    )
  ) {
    return refuse();
  }
  return { dev: value.dev, ino: value.ino };
}

/** A timeout or unfinished continuation permanently retains the fixture's global
 * doubles and private environment. Late settlement cannot grant teardown. */
export function retainedRoutingFixtureLifetime(deadline: number) {
  let unknown = false;
  const pending = new Set<Promise<unknown>>();
  const canRestore = () => {
    if (Date.now() >= deadline || pending.size !== 0) {
      unknown = true;
    }
    return !unknown;
  };
  return {
    retain: () => {
      unknown = true;
    },
    canRestore,
    track: <T>(work: Promise<T>): Promise<T> => {
      pending.add(work);
      work.then(
        () => pending.delete(work),
        () => pending.delete(work)
      );
      return work;
    },
  };
}

/** Private-store model only. Docker metadata and child effects are injected;
 * this does not qualify Go formatting, compiler semantics, TLS, SQL or a daemon. */
export async function retainedRoutingFixture(
  lifetime: ReturnType<typeof retainedRoutingFixtureLifetime>
) {
  const outer = await realpath(
    await mkdtemp(join(tmpdir(), "retained-routing-owner-"))
  );
  const root = join(outer, "checkout"),
    home = join(outer, "hack-home");
  await chmod(outer, 0o700);
  await mkdir(join(root, ".hack"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".git"), { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const config = JSON.stringify({
    name: "fixture",
    dev_host: "original.hack.local",
    oauth: { enabled: true },
    open: { prefer: "alias" },
    worktree: { auto_branch: false, inherit_local: false },
  });
  const compose = JSON.stringify({
    name: "fixture",
    networks: { "hack-dev": { external: true } },
    services: {
      db: { image: "synthetic/db:1", volumes: ["data:/data"] },
      web: {
        image: "synthetic/web:1",
        networks: ["default", "hack-dev"],
        labels: LABELS,
      },
    },
    volumes: { data: {} },
  });
  await writeFile(join(root, ".hack/hack.config.json"), config, {
    mode: 0o600,
  });
  await writeFile(join(root, ".hack/docker-compose.yml"), compose, {
    mode: 0o600,
  });
  const candidate = mapLegacyNativeRetainedRouting({
    configText: config,
    composeText: compose,
  }).candidate;
  if (!candidate) {
    return refuse();
  }
  const compiler = join(outer, "compiler");
  const resolution: NativeRoutingResolution = {
    domain: "hack.local",
    domain_origin: "default",
    project_origin: "https://original.hack.local",
    aliases: { oauth: "https://original.hack.gy" },
    oauth_alias: "oauth",
    open_preference: "alias",
    open_preference_origin: "project",
    open_origin: "https://original.hack.gy",
    routes: {
      web: {
        service: "web",
        port: 3000,
        protocol: "http",
        origin: "https://original.hack.local",
        aliases: { oauth: "https://original.hack.gy" },
      },
    },
  };
  const plan = {
    plan_version: 1,
    name: "fixture",
    services: { db: {}, web: {} },
    jobs: {},
    routes: {
      origin: resolution.project_origin,
      aliases: { oauth: { origin: resolution.aliases.oauth } },
      oauth_alias: "oauth",
      http: {
        web: {
          service: "web",
          port: 3000,
          protocol: "http",
          hostname: "project",
        },
      },
    },
    open: { prefer: "alias" },
    worktree: { auto_branch: false, inherit_local: false },
  };
  await writeFile(
    compiler,
    `#!${process.execPath}
const operation=process.argv[2];
if(operation==='--protocol') console.log(JSON.stringify({transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1,routing_plan_version:1}));
else {
 const raw=JSON.parse(await Bun.stdin.text()), request=operation==='compile'?{}:raw, project=operation==='compile'?raw:JSON.parse(request.project);
 if(JSON.stringify(project)!==${JSON.stringify(JSON.stringify(candidate))})process.exit(97);
 const result={transport_version:1,ok:true,semantic_hash:'a'.repeat(64),declared_workloads:{db:'service',web:'service'},plan:${JSON.stringify(plan)}};
 if(operation!=='compile') {result.local_resolution={overlay:null,origin:'project',auto_branch:false,inherit_local:false,resolution_hash:'b'.repeat(64)};if(request.routing_probe===true)result.routing_inputs_required=true;else result.routing_resolution=${JSON.stringify(resolution)};}
 if(operation==='plan')result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:{db:{},web:{}},warnings:[],diagnostics:[]};
 console.log(JSON.stringify(result));
}
`,
    { mode: 0o700 }
  );
  const previousHome = process.env.HACK_HOME;
  process.env.HACK_HOME = home;
  const model = {
    running: false,
    foreign: false,
    wrongDial: false,
    partial: false,
    proxyAccess: true,
    volumeBirth: CREATED,
    webBirth: CREATED,
    engine: "synthetic-retained-routing",
    sqlRow: ROUTING_CANARY,
  };
  const commands: string[][] = [],
    effects: string[][] = [];
  const hooks: {
    afterProbe?: (args: readonly string[]) => Promise<void>;
    afterEffect?: () => Promise<void>;
  } = {};
  const json = (value: unknown) => JSON.stringify(value);
  const names = ["db", "web"] as const;
  const service = (id: string | undefined) =>
    names.find((name) => ROUTING_IDS[name] === id) ?? refuse();
  const probe: ReturnType<typeof ownership.createNativeComposeProbe> = async (
    input
  ) => {
    const args = [...input];
    commands.push(args);
    const [kind, action] = args,
      format = args[args.indexOf("--format") + 1] ?? "",
      id = args.at(-1);
    let result: string;
    if (kind === "info" && action === "--format") {
      result =
        format === "{{json .ID}}"
          ? json(model.engine)
          : json({ id: model.engine, os: "linux" });
    } else if (
      kind === "exec" &&
      args[1] === ROUTING_IDS.proxy &&
      args.at(-1) === "http://127.0.0.1:2019/config/apps/http/servers"
    ) {
      if (!model.proxyAccess) {
        return refuse();
      }
      const routes = model.running
        ? [
            {
              match: [{ host: LABELS.caddy.split(",") }],
              handle: [
                {
                  handler: "reverse_proxy",
                  upstreams: [
                    {
                      dial: `${model.wrongDial ? "172.28.0.99" : "172.28.0.3"}:3000`,
                    },
                  ],
                },
              ],
              terminal: true,
            },
          ]
        : [];
      result = `${json({
        srv0: { listen: [":443"], tls_connection_policies: [{}], routes },
      })}\n200`;
    } else if (kind === "compose" && args.at(-2) === "--hash" && id === "*") {
      const file = args[args.indexOf("--file") + 1];
      if (!file || (await readFile(file, "utf8")) !== compose) {
        return refuse();
      }
      result = `db ${HASH}\nweb ${HASH}`;
    } else if (
      action === "ls" &&
      kind === "container" &&
      format === "{{json .ID}}" &&
      args.includes("label=com.docker.compose.project=hack-dev-proxy")
    ) {
      result = json(ROUTING_IDS.proxy);
    } else if (
      action === "ls" &&
      ["container", "network", "volume"].includes(kind ?? "")
    ) {
      if (args.some((arg) => arg.startsWith("label=io.hack.native-config."))) {
        result = "";
      } else if (kind === "container" && format === '{"id":{{json .ID}}}') {
        result = [
          ROUTING_IDS.db,
          ROUTING_IDS.web,
          ROUTING_IDS.proxy,
          ...(model.foreign ? [ROUTING_IDS.foreign] : []),
        ]
          .map((value) => json({ id: value }))
          .join("\n");
      } else if (
        kind !== undefined &&
        format === LIST_FORMATS[kind] &&
        json(args) ===
          json([
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            ...(kind === "volume" ? [] : ["--no-trunc"]),
            "--format",
            format,
          ])
      ) {
        result = (
          kind === "container"
            ? names.map((name) => ({
                id: ROUTING_IDS[name],
                name: `fixture-${name}-1`,
                project: "fixture",
              }))
            : kind === "network"
              ? [
                  {
                    id: ROUTING_IDS.network,
                    name: "fixture_default",
                    project: "fixture",
                  },
                ]
              : [
                  {
                    id: "fixture_data",
                    name: "fixture_data",
                    project: "fixture",
                  },
                ]
        )
          .map(json)
          .join("\n");
      } else {
        return refuse();
      }
    } else if (kind === "network" && action === "inspect") {
      if (id === "hack-dev") {
        result = json({ id: ROUTING_IDS.ingress, name: "hack-dev" });
      } else if (id === ROUTING_IDS.ingress && format.includes("created")) {
        result = json({ id, created: CREATED });
      } else if (id === ROUTING_IDS.network) {
        result = json({
          id,
          name: "fixture_default",
          project: "fixture",
          native: "",
          logical: "default",
          createdAt: CREATED,
          driver: "bridge",
          scope: "local",
          internal: false,
          containers: model.running ? [ROUTING_IDS.db, ROUTING_IDS.web] : [],
        });
      } else {
        return refuse();
      }
    } else if (
      kind === "volume" &&
      action === "inspect" &&
      id === "fixture_data"
    ) {
      result = json({
        id,
        name: id,
        project: "fixture",
        native: "",
        storage: "data",
        createdAt: model.volumeBirth,
        driver: "local",
        scope: "local",
        mountpoint: "/var/lib/docker/volumes/fixture_data/_data",
        options: null,
      });
    } else if (kind === "container" && action === "inspect") {
      if (format.includes('"sites"') && !format.includes('"created"')) {
        result = args
          .slice(4)
          .map((selected) =>
            json({
              id: selected,
              sites:
                selected === ROUTING_IDS.web || selected === ROUTING_IDS.foreign
                  ? [LABELS.caddy, null]
                  : [null],
            })
          )
          .join("\n");
      } else if (id === ROUTING_IDS.proxy) {
        result = format.includes('"created"')
          ? json({ id, created: CREATED })
          : json({
              id,
              project: "hack-dev-proxy",
              service: "caddy",
              running: true,
              network: ROUTING_IDS.ingress,
              ip: "172.28.0.2",
            });
      } else {
        const name = service(id);
        if (format.includes('"sites"')) {
          result = json({
            id,
            created: name === "web" ? model.webBirth : CREATED,
            project: "fixture",
            native: "",
            service: name,
            number: "1",
            oneoff: "False",
            running: model.running,
            paused: false,
            sites:
              name === "web"
                ? [
                    ...Object.entries(LABELS).map(([key, value]) => ({
                      key,
                      value,
                    })),
                    null,
                  ]
                : [null],
            networks: [
              {
                name: "fixture_default",
                id: ROUTING_IDS.network,
                ip: model.running ? "172.27.0.3" : "",
              },
              ...(name === "web"
                ? [
                    {
                      name: "hack-dev",
                      id: ROUTING_IDS.ingress,
                      ip: model.running ? "172.28.0.3" : "",
                    },
                  ]
                : []),
              null,
            ],
          });
        } else if (format.includes("config-hash")) {
          result = json({ id, hash: HASH });
        } else if (format.includes(".Mounts")) {
          result = json({
            id,
            name: `/fixture-${name}-1`,
            project: "fixture",
            native: "",
            service: name,
            number: "1",
            oneoff: "False",
            running: model.running,
            workingDir: join(root, ".hack"),
            configFiles: join(root, ".hack/docker-compose.yml"),
            mounts:
              name === "db"
                ? [
                    {
                      type: "volume",
                      name: "fixture_data",
                      source: "/var/lib/docker/volumes/fixture_data/_data",
                      target: "/data",
                      rw: true,
                    },
                  ]
                : [],
            networks: [
              { name: "fixture_default", id: ROUTING_IDS.network },
              ...(name === "web"
                ? [{ name: "hack-dev", id: ROUTING_IDS.ingress }]
                : []),
            ],
          });
        } else if (format.includes(".State.Running")) {
          result = json({
            id,
            running: model.running,
            paused: false,
            status: model.running ? "running" : "exited",
            ...(format.includes("Health") ? { health: "" } : {}),
          });
        } else {
          return refuse();
        }
      }
    } else {
      return refuse();
    }
    await hooks.afterProbe?.(args);
    return result;
  };
  const originalKill = process.kill;
  const spies = [
    spyOn(ownership, "createNativeComposeProbe").mockImplementation(
      () => probe
    ),
    spyOn(engine, "createNativeComposeEngineIdentityObserver").mockReturnValue(
      null
    ),
    spyOn(shell, "run").mockImplementation(async (args, opts = {}) => {
      opts.beforeSpawn?.();
      if (
        JSON.stringify(args) !==
          json([
            "docker",
            "container",
            args[2],
            ROUTING_IDS.db,
            ROUTING_IDS.web,
          ]) ||
        !["start", "restart", "stop"].includes(args[2] ?? "")
      ) {
        return refuse();
      }
      await opts.onSpawn?.({
        pid: GROUP,
        ownsProcessGroup: true,
        processGroupId: GROUP,
      });
      effects.push([...args]);
      model.running = args[2] !== "stop";
      await hooks.afterEffect?.();
      return model.partial ? 7 : 0;
    }),
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -GROUP && signal === 0) {
        throw Object.assign(new Error("synthetic absent"), { code: "ESRCH" });
      }
      return originalKill.call(process, pid, signal);
    }),
  ];
  const receiptPath = join(
    root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  return {
    root,
    outer,
    home,
    compiler,
    config,
    compose,
    model,
    resolution,
    hooks,
    commands,
    effects,
    receiptPath,
    canRestore: lifetime.canRestore,
    track: lifetime.track,
    receipt: async () => {
      const value: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
      if (!(isRecord(value) && isRecord(value.checkout))) {
        return refuse();
      }
      return parseLegacyComposeAdoptionReceipt(value, {
        root: identity(value.checkout.root),
        project: identity(value.checkout.project),
        git: identity(value.checkout.git),
      });
    },
    store: () =>
      openLegacyComposeAdoptedGenerationStore({
        projectRoot: root,
        timeoutMs: 15_000,
      }),
    operation: async (
      store: Awaited<
        ReturnType<typeof openLegacyComposeAdoptedGenerationStore>
      >,
      generation: Parameters<typeof store.withMutation>[0]["generation"],
      operation: "start" | "stop",
      opts: {
        readonly recover?: boolean;
        readonly numeric?: boolean;
        readonly preparation?: boolean;
      } = {}
    ) => {
      const deadline = Date.now() + 15_000;
      const run = async (
        input: Parameters<Parameters<typeof store.withMutation>[0]["run"]>[0]
      ) =>
        opts.numeric
          ? 0
          : await runLegacyComposeRetainedRoutingOperation({
              input,
              operation,
              deadline,
            });
      return opts.preparation
        ? await store.withPreparationStop({
            generation,
            binary: compiler,
            deadline,
            recover: opts.recover,
            run,
          })
        : await store.withMutation({
            generation,
            operation,
            services: [],
            binary: compiler,
            deadline,
            recover: opts.recover,
            run,
          });
    },
    cleanup: async () => {
      if (!lifetime.canRestore()) {
        return refuse();
      }
      for (const spy of spies) {
        spy.mockRestore();
      }
      restoreEnv("HACK_HOME", previousHome);
      await rm(outer, { recursive: true, force: true });
    },
  };
}
