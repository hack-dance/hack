import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../../src/lib/guards.ts";
import type { CliResult } from "../harness.ts";
import { adoptionDependencyReadAllowed } from "./native-compose-adoption-dependency-inputs.ts";
import {
  type AdoptionDependencyFirstPrepare,
  captureAdoptionDependencyFirstPrepare,
} from "./native-compose-adoption-dependency-staged-read.ts";

const ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type Instance = { readonly root: string; readonly name: string };
type ReadScope = {
  readonly projectRoot: string;
  readonly project: string;
  readonly containerIds: readonly string[];
  readonly networkId: string;
  readonly volumeName: string;
};
export type SourceBindFixtureScope = ReadScope & {
  readonly db: string;
  readonly worker: string;
};
export const SOURCE_BIND_FIXTURE_DIRS = [
  "bind-ro",
  "bind-rw",
  "bind-generated",
] as const;
export const SOURCE_BIND_FIXTURE_INSPECT_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"nativeNames":[{{$first := true}}{{range $name,$value := .Config.Labels}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}{{end}}],"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{if eq $m.Type "bind"}}{{json (index $m "Name")}}{{else}}{{json $m.Name}}{{end}},"source":{{if eq $m.Type "bind"}}{{json $m.Source}}{{else}}null{{end}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}]}`;
const ROLE_MARKER = ".source-bind-witness";

function refuse(): never {
  throw new Error("Retained source-bind fixture refused; values omitted.");
}
function marker(instance: Instance, role: string) {
  if (!NAME.test(instance.name)) {
    refuse();
  }
  return `source-bind-${instance.name}-${role}\n`;
}

/** Synthetic authored inputs only. The retained owner never creates or repairs these paths. */
export async function prepareSourceBindFixtureSources(instance: Instance) {
  for (const path of SOURCE_BIND_FIXTURE_DIRS) {
    await mkdir(join(instance.root, path), { recursive: true, mode: 0o700 });
    await writeFile(
      join(instance.root, path, "marker"),
      marker(instance, path),
      { mode: 0o600 }
    );
  }
  await writeFile(
    join(instance.root, ROLE_MARKER),
    marker(instance, "checkout"),
    { mode: 0o600 }
  );
  await writeFile(join(instance.root, ".gitignore"), "bind-generated/\n", {
    flag: "a",
    mode: 0o600,
  });
}

/** Both explicit access modes and a checkout-root bind survive without access expansion. */
export function sourceBindFixtureMounts(second: boolean): readonly unknown[] {
  return second
    ? [
        {
          type: "bind",
          source: "../bind-ro",
          target: "/source-ro",
          read_only: true,
          bind: { create_host_path: false },
        },
        "../bind-rw:/source-rw:rw",
        {
          type: "bind",
          source: "../bind-generated",
          target: "/source-generated",
          read_only: true,
          bind: { create_host_path: false },
        },
        "..:/checkout:ro",
      ]
    : [
        "../bind-ro:/source-ro:ro",
        {
          type: "bind",
          source: "../bind-rw",
          target: "/source-rw",
          read_only: false,
          bind: { create_host_path: false },
        },
        "../bind-generated:/source-generated:ro",
        {
          type: "bind",
          source: "..",
          target: "/checkout",
          read_only: true,
          bind: { create_host_path: false },
        },
      ];
}

/** Identity proof deliberately excludes file bytes and directory timestamps, which RW activity can change. */
export async function sourceBindFixtureDirectorySnapshot(
  root: string
): Promise<string> {
  const result: {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly uid: number;
  }[] = [];
  for (const path of [".", ...SOURCE_BIND_FIXTURE_DIRS]) {
    const info = await lstat(join(root, path));
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    ) {
      refuse();
    }
    result.push({
      path,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      uid: info.uid,
    });
  }
  return JSON.stringify(result);
}

/** Exact existing bind rows, with the named database mount independently retained. No duplicate is discarded. */
export function sourceBindFixtureMountObservation(opts: {
  readonly instance: Instance;
  readonly service: string;
  readonly mounts: unknown;
}): string {
  if (!Array.isArray(opts.mounts)) {
    refuse();
  }
  const rows: {
    readonly type: string;
    readonly name: string | null;
    readonly source: string | null;
    readonly target: string;
    readonly rw: boolean;
  }[] = [];
  for (const raw of opts.mounts) {
    if (
      !(
        isRecord(raw) &&
        Object.keys(raw).sort().join() === "name,rw,source,target,type" &&
        typeof raw.type === "string" &&
        (typeof raw.name === "string" || raw.name === null) &&
        (typeof raw.source === "string" || raw.source === null) &&
        typeof raw.target === "string" &&
        typeof raw.rw === "boolean"
      )
    ) {
      refuse();
    }
    rows.push({
      type: raw.type,
      name: raw.name,
      source: raw.source,
      target: raw.target,
      rw: raw.rw,
    });
  }
  const expected: typeof rows = [
    {
      type: "volume",
      name: `${opts.instance.name}_data`,
      source: null,
      target: "/var/lib/postgresql/data",
      rw: opts.service === "db",
    },
  ];
  if (opts.service === "worker") {
    for (const [path, target, rw] of [
      ["bind-ro", "/source-ro", false],
      ["bind-rw", "/source-rw", true],
      ["bind-generated", "/source-generated", false],
      [".", "/checkout", false],
    ] as const) {
      const name = rows.find((row) => row.target === target)?.name;
      if (name !== null && name !== "") {
        refuse();
      }
      expected.push({
        type: "bind",
        name,
        source: join(opts.instance.root, path),
        target,
        rw,
      });
    }
  } else if (opts.service !== "db") {
    refuse();
  }
  const ordered = (values: typeof rows) =>
    values.toSorted((a, b) => a.target.localeCompare(b.target));
  if (JSON.stringify(ordered(rows)) !== JSON.stringify(ordered(expected))) {
    refuse();
  }
  return JSON.stringify(ordered(rows));
}

/** Complete silent guest oracle: RO writes fail, RW writes persist, root binding exposes the same files. */
export function sourceBindFixtureAccessScript(instance: Instance): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "set -eu",
    `test "$(cat /source-ro/marker)" = ${quote(marker(instance, "bind-ro").trim())}`,
    `test "$(cat /source-generated/marker)" = ${quote(marker(instance, "bind-generated").trim())}`,
    `test "$(cat /checkout/${ROLE_MARKER})" = ${quote(marker(instance, "checkout").trim())}`,
    "if (printf denied >/source-ro/forbidden) 2>/dev/null; then exit 31; fi",
    "if (printf denied >/source-generated/forbidden) 2>/dev/null; then exit 32; fi",
    "if (printf denied >/checkout/forbidden) 2>/dev/null; then exit 33; fi",
    `printf '%s\\n' ${quote(marker(instance, "rw-written").trim())} >/source-rw/runtime-marker`,
    `test "$(cat /source-rw/runtime-marker)" = ${quote(marker(instance, "rw-written").trim())}`,
    `test "$(cat /checkout/bind-rw/runtime-marker)" = ${quote(marker(instance, "rw-written").trim())}`,
    "",
  ].join("; ");
}

export async function assertSourceBindFixtureHostBytes(instance: Instance) {
  for (const path of SOURCE_BIND_FIXTURE_DIRS) {
    if (
      (await readFile(join(instance.root, path, "marker"), "utf8")) !==
      marker(instance, path)
    ) {
      refuse();
    }
  }
  if (
    (await readFile(join(instance.root, ROLE_MARKER), "utf8")) !==
      marker(instance, "checkout") ||
    (await readFile(join(instance.root, "bind-rw/runtime-marker"), "utf8")) !==
      marker(instance, "rw-written")
  ) {
    refuse();
  }
  for (const path of [
    "bind-ro/forbidden",
    "bind-generated/forbidden",
    "forbidden",
  ]) {
    try {
      await lstat(join(instance.root, path));
      refuse();
    } catch (error: unknown) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        refuse();
      }
    }
  }
}

// Fixed public owner template only. A correspondence control obtains the actual
// shipping owner query; authored values and private revision hashes never appear here.
export const SOURCE_BIND_FIXTURE_OWNER_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"native":{{json (index .Config.Labels "io.hack.native-config.version")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"number":{{json (index .Config.Labels "com.docker.compose.container-number")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"running":{{json .State.Running}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":[{{range $i, $m := .Mounts}}{{if $i}},{{end}}{"type":{{json $m.Type}},"name":{{if eq $m.Type "bind"}}{{json (index $m "Name")}}{{else}}{{json $m.Name}}{{end}},"source":{{json $m.Source}},"target":{{json $m.Destination}},"rw":{{json $m.RW}}}{{end}}],"networks":[{{$first := true}}{{range $name, $n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"name":{{json $name}},"id":{{json $n.NetworkID}}}{{end}}]}`;

/** Old closed reads plus exactly the v12 bind inspection on captured original IDs. */
export function sourceBindFixtureReadAllowed(
  opts: ReadScope & {
    readonly args: readonly string[];
    readonly generationId?: unknown;
  }
): boolean {
  const { args } = opts;
  return (
    adoptionDependencyReadAllowed(opts) ||
    (args.length === 5 &&
      args[0] === "container" &&
      args[1] === "inspect" &&
      args[2] === "--format" &&
      args[3] === SOURCE_BIND_FIXTURE_OWNER_FORMAT &&
      opts.containerIds.includes(args[4] ?? ""))
  );
}

/** A full captured v12 generation and whole original-ID selection are required before each forwarded effect. */
export function sourceBindFixtureMutationAllowed(opts: {
  readonly args: readonly string[];
  readonly scope: SourceBindFixtureScope;
  readonly receipt: unknown;
  readonly recoverPendingStartStop: boolean;
}): boolean {
  const { args, scope, receipt } = opts;
  if (
    !(
      args.length === 3 &&
      args[0] === "container" &&
      ["start", "stop"].includes(args[1] ?? "") &&
      ID.test(scope.db) &&
      ID.test(scope.worker) &&
      scope.db !== scope.worker &&
      scope.containerIds.length === 2 &&
      JSON.stringify([...scope.containerIds].sort()) ===
        JSON.stringify([scope.db, scope.worker].sort()) &&
      scope.containerIds.includes(args[2] ?? "") &&
      isRecord(receipt) &&
      receipt.adoption_receipt_version === 12 &&
      isRecord(receipt.pendingOperation) &&
      Object.keys(receipt.pendingOperation).sort().join() ===
        "generation,operation,services" &&
      sourceBindFixtureAnchor(receipt.prepared) &&
      sourceBindFixtureAnchor(receipt.pendingOperation.generation) &&
      Array.isArray(receipt.pendingOperation.services) &&
      JSON.stringify([...receipt.pendingOperation.services].sort()) ===
        '["db","worker"]'
    )
  ) {
    return false;
  }
  const pending = receipt.pendingOperation;
  if (
    !(
      pending.operation === args[1] ||
      (opts.recoverPendingStartStop &&
        args[1] === "stop" &&
        pending.operation === "start" &&
        isRecord(receipt.publication) &&
        receipt.publication.phase === "active")
    )
  ) {
    return false;
  }
  const selected =
    args[1] === "stop" && receipt.publication === null
      ? receipt.prepared
      : isRecord(receipt.publication) && receipt.publication.phase === "active"
        ? receipt.publication.generation
        : undefined;
  return (
    sourceBindFixtureAnchor(selected) &&
    JSON.stringify(selected) === JSON.stringify(pending.generation) &&
    JSON.stringify(selected) === JSON.stringify(receipt.prepared)
  );
}

function sourceBindFixtureAnchor(value: unknown): boolean {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() === "id,manifest" &&
      typeof value.id === "string" &&
      TOKEN.test(value.id) &&
      isRecord(value.manifest) &&
      Object.keys(value.manifest).sort().join() === "dev,hash,ino"
    )
  ) {
    return false;
  }
  return (
    Number.isSafeInteger(value.manifest.dev) &&
    Number(value.manifest.dev) >= 0 &&
    Number.isSafeInteger(value.manifest.ino) &&
    Number(value.manifest.ino) > 0 &&
    typeof value.manifest.hash === "string" &&
    HASH.test(value.manifest.hash)
  );
}

export type SourceBindFixtureInterruption =
  | "none"
  | "prepared-stop"
  | "replace-after-start";

/** Emitted actual transport. It has no generic Docker mutation passthrough. */
export function sourceBindFixtureDockerScript(opts: {
  readonly engine: string;
  readonly engineId: string;
  readonly receipt: string;
  readonly scope: SourceBindFixtureScope;
  readonly firstPrepare?: AdoptionDependencyFirstPrepare;
  readonly recoverPendingStartStop: boolean;
  readonly interruption: SourceBindFixtureInterruption;
  readonly control: string;
}): string {
  const helper = fileURLToPath(
    new URL("./native-compose-adoption-source-bind-inputs.ts", import.meta.url)
  );
  const staged = fileURLToPath(
    new URL(
      "./native-compose-adoption-dependency-staged-read.ts",
      import.meta.url
    )
  );
  const probe = fileURLToPath(
    new URL("../../../src/lib/native-compose-ownership.ts", import.meta.url)
  );
  const shell = fileURLToPath(
    new URL("../../../src/lib/shell.ts", import.meta.url)
  );
  return `#!${process.execPath}
import {sourceBindFixtureReadAllowed,sourceBindFixtureMutationAllowed} from ${JSON.stringify(helper)};
import {adoptionDependencyStagedReadAllowed} from ${JSON.stringify(staged)};
import {createNativeComposeProbe} from ${JSON.stringify(probe)};
import {run} from ${JSON.stringify(shell)};
import {mkdir,rename,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2), engine=${JSON.stringify(opts.engine)}, scope=${JSON.stringify(opts.scope)};
const deadline=Date.now()+120000;
function remaining(){const value=deadline-Date.now();if(value<=0)throw new Error('expired');return value;}
function refused(stage,code){console.error('source-bind-refused stage='+stage+' code='+code);process.exit(code);}
try {
 const file=Bun.file(${JSON.stringify(opts.receipt)}), exists=await file.exists();
 if(exists && file.size>65536)refused('receipt',92);
 const receipt=exists?JSON.parse(await file.text()):null;
 if(args[0]==='container' && ['start','stop'].includes(args[1])) {
  if(!sourceBindFixtureMutationAllowed({args,scope,receipt,recoverPendingStartStop:${opts.recoverPendingStartStop}}))refused('mutation-admission',94);
  const observed=(await createNativeComposeProbe({timeoutMs:Math.min(10000,remaining())})(['info','--format','{{json .ID}}'])).trim();
  if(observed!==${JSON.stringify(opts.engineId)})refused('daemon',95);
  ${opts.interruption === "prepared-stop" ? `if(args[1]!=='stop'||args[2]!==scope.worker)refused('partial-stop',96);` : ""}
  const code=await run([engine,...args],{stdin:'ignore',stdout:'ignore',stderr:'ignore',forwardSignals:true,timeoutMs:remaining(),beforeSpawn:remaining});
  remaining();
  if(code===0 && ${opts.interruption === "prepared-stop"}) {
   await writeFile(${JSON.stringify(opts.control)},'prepared-stop-original-worker',{mode:0o600,flag:'wx'});process.exit(71);
  }
  if(code===0 && args[1]==='start' && args[2]===scope.db && ${opts.interruption === "replace-after-start"}) {
   await writeFile(${JSON.stringify(opts.control)},'original-start-before-directory-replacement',{mode:0o600,flag:'wx'});
   await rename(scope.projectRoot+'/bind-rw',scope.projectRoot+'/bind-rw-original');
   await mkdir(scope.projectRoot+'/bind-rw',{mode:0o700});process.exit(71);
  }
  process.exit(code);
 }
 const generationId=receipt?.prepared?.id ?? receipt?.publication?.generation?.id;
 const allowed=sourceBindFixtureReadAllowed({...scope,args,generationId})${opts.firstPrepare ? ` || await adoptionDependencyStagedReadAllowed({args,project:scope.project,first:${JSON.stringify(opts.firstPrepare)}})` : ""};
 if(!allowed)refused('read-admission',93);
 process.exit(await run([engine,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit',forwardSignals:true,timeoutMs:remaining(),beforeSpawn:remaining}));
}catch{refused('transport',92);}
`;
}

type Outcome = Pick<CliResult, "exitCode" | "timedOut" | "stdout" | "stderr">;
const OPERATIONS = [
  [["config", "adopt", "--dry-run", "--stop", "--json"], "preview"],
  [["config", "adopt", "--stop", "--json"], "adopt-stop"],
  [["config", "adopt", "--recover", "--stop", "--json"], "recover-adopt-stop"],
  [["config", "adopt", "--rollback", "--json"], "rollback"],
  [["up", "--detach", "--json"], "start"],
  [["up", "db", "--detach", "--json"], "partial-selection"],
  [["down", "--json"], "stop"],
  [["down", "--recover", "--json"], "recover-stop"],
  [["run", "db", "--", "true"], "run-refusal"],
] as const;
const CODES = [
  "E_CONFIG_INVALID",
  "E_STATE",
  "E_LIFECYCLE_FAILED",
  "E_NATIVE_COMPOSE_ADOPTION",
] as const;

function outcomeCode(result: Outcome): string {
  try {
    if (Buffer.byteLength(result.stdout) > 65_536) {
      return "unavailable";
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (isRecord(parsed) && parsed.ok === true) {
      return "none";
    }
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const error = parsed.error;
      return CODES.find((value) => value === error.code) ?? "unavailable";
    }
  } catch {
    /* Reply values and arbitrary errors are never evidence fields. */
  }
  return "unavailable";
}

/** Every actual source-bind invocation, including previews, uses the emitted closed guard. */
export async function sourceBindFixtureCli<T extends Outcome>(opts: {
  readonly tempRoot: string;
  readonly engine: string;
  readonly engineId: string;
  readonly scope: SourceBindFixtureScope;
  readonly args: readonly string[];
  readonly interruption?: SourceBindFixtureInterruption;
  readonly run: (env: Readonly<Record<string, string>>) => Promise<T>;
}): Promise<T> {
  const args = Object.freeze([...opts.args]);
  const interruption = opts.interruption ?? "none";
  const { tempRoot, engine, engineId, run } = opts;
  const path = process.env.PATH ?? "/usr/bin:/bin";
  const scope = Object.freeze({
    ...opts.scope,
    containerIds: Object.freeze([...opts.scope.containerIds]),
  });
  if (
    !(
      ["none", "prepared-stop", "replace-after-start"].includes(interruption) &&
      (interruption !== "prepared-stop" ||
        JSON.stringify(args) === '["config","adopt","--stop","--json"]') &&
      (interruption !== "replace-after-start" ||
        JSON.stringify(args) === '["up","--detach","--json"]')
    )
  ) {
    refuse();
  }
  const shimRoot = join(tempRoot, `source-bind-shim-${crypto.randomUUID()}`);
  await mkdir(shimRoot, { mode: 0o700 });
  const receipt = join(
    scope.projectRoot,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const firstPrepare =
    args[0] === "config" &&
    args[1] === "adopt" &&
    !(await Bun.file(receipt).exists())
      ? await captureAdoptionDependencyFirstPrepare({
          projectRoot: scope.projectRoot,
        })
      : undefined;
  const control = join(shimRoot, "control");
  const script = sourceBindFixtureDockerScript({
    engine,
    engineId,
    scope,
    receipt,
    firstPrepare,
    interruption,
    control,
    recoverPendingStartStop:
      JSON.stringify(args) === '["down","--recover","--json"]',
  });
  const shim = join(shimRoot, "docker");
  await writeFile(shim, script, { mode: 0o700, flag: "wx" });
  const operation =
    OPERATIONS.find(
      ([expected]) => JSON.stringify(expected) === JSON.stringify(args)
    )?.[1] ?? "unavailable";
  const started = performance.now();
  const emit = async (
    stage: "begin" | "result" | "settled" | "thrown",
    result?: Outcome
  ) => {
    try {
      const row = {
        evidence_version: 1,
        operation,
        stage,
        elapsedMs: Math.round(performance.now() - started),
        ...(result
          ? {
              exit:
                Number.isInteger(result.exitCode) &&
                result.exitCode >= 0 &&
                result.exitCode <= 255
                  ? result.exitCode
                  : "unavailable",
              timedOut: result.timedOut === true,
              code: outcomeCode(result),
              readGuardRefused: result.stderr.includes(
                "source-bind-refused stage=read-admission code=93"
              ),
              mutationGuardRefused: result.stderr.includes(
                "source-bind-refused stage=mutation-admission code=94"
              ),
            }
          : {}),
      };
      await writeFile(join(shimRoot, `${stage}.json`), JSON.stringify(row), {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      /* Evidence cannot change the original result or error. */
    }
  };
  await emit("begin");
  try {
    const result = await run({ PATH: `${shimRoot}:${path}` });
    await emit("result", result);
    if (interruption !== "none") {
      const expected =
        interruption === "prepared-stop"
          ? "prepared-stop-original-worker"
          : "original-start-before-directory-replacement";
      if (
        result.exitCode === 0 ||
        result.timedOut ||
        (await Bun.file(control).text()) !== expected
      ) {
        refuse();
      }
    }
    return result;
  } catch (error: unknown) {
    await emit("thrown");
    throw error;
  } finally {
    await emit("settled");
  }
}
