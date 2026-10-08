import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const PROTOCOL = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  host_env_plan_version: 1,
  endpoint_plan_version: 1,
};
const TARGET = {
  kind: "external",
  hostname: "old.example.invalid",
  port: 80,
  protocol: "http",
};

/** Only compiler/Docker transports are substituted; the source CLI and all input owners are real. */
async function fixture(hook: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-before-command-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  const source = {
    schema_version: 1,
    name: "fixture",
    source: { root: ".", mode: "host-mounted" },
    worktree: { inherit_local: false, auto_branch: false },
    services: {
      web: {
        image: "fixture/web:1",
        environment: {
          URL: { endpoint: { kind: "host_binding", name: "external" } },
        },
      },
    },
    host_bindings: { external: TARGET },
    host: {
      up: {
        before: [
          {
            name: "prepare",
            command: { exec: [process.execPath, "-e", hook] },
          },
        ],
      },
    },
  };
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(source)
  );
  await Bun.write(
    join(root, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: "before" }, host: { HOST_ONLY: "host" } },
    })
  );
  const compiler = join(root, "compiler");
  await Bun.write(
    compiler,
    `#!${process.execPath}
import {createHash} from "node:crypto";
if(process.argv[2]==="--protocol") console.log(${JSON.stringify(JSON.stringify(PROTOCOL))});
else {
 const operation=process.argv[2];const raw=await Bun.stdin.text();
 const request=operation==="compile"?{}:JSON.parse(raw);
 const text=operation==="compile"?raw:request.project;const source=JSON.parse(text);
 const plan={...source,plan_version:1,selected_profiles:[],jobs:{},environment:{},storage:{},host:{up:{before:source.host.up.before.map(h=>({...h,environment:h.environment??{},env_target:{kind:"host"}}))}}}; delete plan.schema_version;
 const result={transport_version:1,ok:true,semantic_hash:createHash("sha256").update(text).digest("hex"),declared_workloads:{web:"service"},host_env_targets:{include_default:true,workloads:[]},plan};
 if(operation!=="compile") {
  const local=request.checkout_local?JSON.parse(request.checkout_local):null;
  const target=local?.host_bindings?.external??source.host_bindings.external;
  result.local_resolution={overlay:null,origin:"project",auto_branch:false,inherit_local:false,resolution_hash:"b".repeat(64)};
  result.host_binding_resolution={bindings:{external:{target,origin:local?"checkout_local":"project"}},removed:{}};
 }
 if(operation==="plan") {
  const metadata=request.env_metadata;
  const bindings=entries=>Object.fromEntries(Object.entries(entries).map(([key,entry])=>[key,{kind:"managed",key,scope:entry.scope,secret:entry.secret}]));
  const web=bindings(metadata.workloads.web);web.URL={kind:"endpoint",reference:{kind:"host_binding",name:"external"},target:result.host_binding_resolution.bindings.external.target};
  result.environment_plan={plan_version:1,overlay:metadata.overlay,overlay_exists:metadata.overlay_exists,complete:true,workloads:{web},host:Object.fromEntries(plan.host.up.before.map(h=>[h.name,{env_target:h.env_target,bindings:bindings(metadata.host.default)}])),warnings:[],diagnostics:[]};
 }
 console.log(JSON.stringify(result));
}
`
  );
  const docker = join(root, "docker");
  await Bun.write(
    docker,
    `#!${process.execPath}
import {appendFile} from "node:fs/promises";
await appendFile(${JSON.stringify(join(root, "docker-requests"))},JSON.stringify(process.argv.slice(2))+"\\n");
// Refuse at the first read-only ownership query, after private publication.
process.exit(23);
`
  );
  await chmod(compiler, 0o700);
  await chmod(docker, 0o700);
  return root;
}

async function invoke(root: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "--path",
      root,
      "up",
      "--detach",
      "--json",
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
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function generations(root: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob(
    ".hack/.internal/native-compose/*/generations/*/compose.json"
  ).scan({ cwd: root, absolute: true })) {
    paths.push(path);
  }
  return paths;
}

test("source CLI refreshes managed values and local external bindings after before hooks", async () => {
  const root = await fixture(
    `await Bun.write(".hack/hack.env.default.yaml",JSON.stringify({version:1,environment:"default",secretsprovider:"project_key",values:{global:{TOKEN:"after"},host:{HOST_ONLY:"host"}}})); await Bun.write(".hack/hack.local.json",JSON.stringify({schema_version:1,host_bindings:{external:{kind:"external",hostname:"new.example.invalid",port:8443,protocol:"https"}}}));`
  );
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_CONFIG_INVALID" },
  });
  const paths = await generations(root);
  expect(paths).toHaveLength(1);
  const [path] = paths;
  if (!path) {
    throw new Error("Expected a published private generation");
  }
  expect(await Bun.file(path).json()).toMatchObject({
    services: {
      web: {
        environment: {
          TOKEN: "after",
          URL: "https://new.example.invalid:8443",
        },
      },
    },
  });
  const document = await Bun.file(path).text();
  expect(document).not.toContain("HOST_ONLY");
  expect(document).not.toContain("old.example.invalid");
  const requests = (await Bun.file(join(root, "docker-requests")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(requests).toHaveLength(1);
  expect(requests[0].slice(0, 2)).toEqual(["container", "ls"]);
}, 20_000);

test.each([
  "identity",
  "hooks",
] as const)("source CLI refuses changed %s after before hooks without any Docker request", async (change) => {
  const mutation =
    change === "identity"
      ? 'source.name="replacement";'
      : 'source.host.up.before.push({name:"new-hook",command:{shell:"true"}});';
  const root = await fixture(
    `const source=await Bun.file(".hack/hack.project.json").json();${mutation}await Bun.write(".hack/hack.project.json",JSON.stringify(source));`
  );
  const result = await invoke(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_CONFIG_INVALID",
      message:
        "Native project identity or hook selection changed during before hooks; no engine startup ran. Values omitted.",
    },
  });
  expect(await Bun.file(join(root, "docker-requests")).exists()).toBe(false);
  expect(await generations(root)).toEqual([]);
}, 20_000);

test("source CLI preserves nonzero hook status and makes no Docker request or generation", async () => {
  const root = await fixture("process.exit(17)");
  const result = await invoke(root);
  expect(result.code).toBe(17);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_LIFECYCLE_FAILED" },
  });
  expect(await Bun.file(join(root, "docker-requests")).exists()).toBe(false);
  expect(await generations(root)).toEqual([]);
}, 20_000);
