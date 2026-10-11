import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** Source CLI/private stores are real; only the compiler and read-only Docker transport are substituted. */
async function invoke(opts: {
  readonly network: "data" | "default";
  readonly operation: "up" | "run";
  /** Declared persistent storage activates the engine dependency check before hooks. */
  readonly storage?: boolean;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-network-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  const source = {
    schema_version: 1,
    name: "fixture",
    source: { root: ".", mode: "host-mounted" },
    worktree: { auto_branch: false, inherit_local: false },
    networks: { data: { internal: true } },
    ...(opts.storage
      ? { storage: { data: { kind: "persistent", scope: "worktree" } } }
      : {}),
    services: {
      web: { image: "fixture/web:1", networks: { [opts.network]: {} } },
    },
  };
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(source)
  );
  await Bun.write(
    join(root, "compiler"),
    `#!${process.execPath}
import {createHash} from "node:crypto";
const operation=process.argv[2];
if(operation==="--protocol") console.log(JSON.stringify({transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1,network_plan_version:1}));
else {
 const raw=await Bun.stdin.text(), request=operation==="compile"?{}:JSON.parse(raw), text=operation==="compile"?raw:request.project, source=JSON.parse(text);
 const {schema_version,...fields}=source;
 const plan={...fields,plan_version:1,selected_profiles:[],jobs:{},environment:{},storage:source.storage??{}};
 const result={transport_version:1,ok:true,semantic_hash:createHash("sha256").update(text).digest("hex"),declared_workloads:{web:"service"},plan};
 if(operation!=="compile") result.local_resolution={overlay:null,origin:"project",auto_branch:false,inherit_local:false,resolution_hash:"b".repeat(64)};
 if(operation==="plan") result.environment_plan={plan_version:1,overlay:null,overlay_exists:false,complete:true,workloads:{web:{}},warnings:[],diagnostics:[]};
 console.log(JSON.stringify(result));
}
`
  );
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import {appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "commands"))},JSON.stringify(args)+"\\n");
if(!(args[0]==="info"||(["container","volume","network"].includes(args[0])&&["ls","inspect"].includes(args[1])))) writeFileSync(${JSON.stringify(join(root, "engine-effect"))},"unexpected mutation");
process.exit(23);
`
  );
  await chmod(join(root, "compiler"), 0o700);
  await chmod(join(root, "docker"), 0o700);
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "--path",
      root,
      ...(opts.operation === "run"
        ? ["run", "web", "--", "true"]
        : ["up", "--detach", "--json"]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        HACK_HOME: join(root, "home"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "global.json"),
        HACK_CONFIG_COMPILER_BINARY: join(root, "compiler"),
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        CI: "1",
        HACK_EXECUTION_MODE: "non_interactive",
        GIT_DIR: "",
        GIT_WORK_TREE: "",
        GIT_COMMON_DIR: "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(await Bun.file(join(root, "engine-effect")).exists()).toBe(false);
    return { root, output: stdout + stderr };
  } finally {
    clearTimeout(timer);
  }
}

test("custom-network oneoff refuses before any Docker observation or mutation", async () => {
  const { root, output } = await invoke({ network: "data", operation: "run" });
  expect(output).toContain("qualified one-off attachment behavior");
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
}, 20_000);

test.each([
  { network: "default", operation: "run" },
  { network: "data", operation: "up" },
] as const)("$network $operation reaches guarded ownership inspection", async (options) => {
  const { root, output } = await invoke(options);
  expect(output).not.toContain("qualified one-off attachment behavior");
  const commands: string[][] = (await Bun.file(join(root, "commands")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands).toHaveLength(1);
  expect(commands[0]?.slice(0, 2)).toEqual(["container", "ls"]);
}, 20_000);

test("custom-network oneoff with declared storage refuses before the engine dependency check", async () => {
  const { root, output } = await invoke({
    network: "data",
    operation: "run",
    storage: true,
  });
  expect(output).toContain("qualified one-off attachment behavior");
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
}, 20_000);

test("default-network oneoff with declared storage reaches the engine dependency check", async () => {
  const { root, output } = await invoke({
    network: "default",
    operation: "run",
    storage: true,
  });
  expect(output).not.toContain("qualified one-off attachment behavior");
  const commands: string[][] = (await Bun.file(join(root, "commands")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands[0]?.[0]).toBe("info");
}, 20_000);
