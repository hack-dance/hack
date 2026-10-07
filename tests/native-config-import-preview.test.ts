import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { previewNativeConfigImport } from "../src/lib/native-config-import-preview.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-private-import-owner";
const PROTOCOL = { transport_version: 1, authored_version: 1, plan_version: 1 };
const SUCCESS = {
  transport_version: 1,
  ok: true,
  plan: { plan_version: 1 },
  semantic_hash: "a".repeat(64),
};
const CONFIG = '{"name":"fixture"}';
const COMPOSE = JSON.stringify({
  services: { web: { image: "fixture:1", environment: { TOKEN: CANARY } } },
});
const KEYS = [
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "HACK_ENV_SECRET_KEY",
  "CI",
] as const;
let root = "";
let projectRoot = "";
let projectDir = "";
let receipt = "";
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-import-preview-"))
  );
  projectRoot = join(root, "project");
  projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "hack.config.json"), CONFIG);
  await writeFile(join(projectDir, "docker-compose.yml"), COMPOSE);
  receipt = join(root, "compiler-receipt");
  process.env.HACK_HOME = join(root, "home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "never-read-global");
  process.env.HACK_ENV_SECRET_KEY = CANARY;
});
afterEach(async () => {
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { recursive: true, force: true });
});

async function compiler(body = "") {
  const binary = join(root, "compiler");
  await writeFile(
    binary,
    `#!${process.execPath}
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify(PROTOCOL))})}
else{
 const raw=await Bun.stdin.text();
 await Bun.write(${JSON.stringify(receipt)},JSON.stringify({raw,keys:Object.keys(process.env).sort(),args:process.argv.slice(2)}));
 ${body}
 console.log(${JSON.stringify(JSON.stringify(SUCCESS))});
}`
  );
  await chmod(binary, 0o700);
  return binary;
}
function refused(
  result: Awaited<ReturnType<typeof previewNativeConfigImport>>,
  expected: string
) {
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(result.report.fields.some((field) => field.code === expected)).toBe(
    true
  );
  expect(JSON.stringify(result)).not.toContain(CANARY);
}
async function ready(path: string) {
  const deadline = Date.now() + 3000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) {
      throw new Error("Fixture did not reach compiler boundary");
    }
    await Bun.sleep(5);
  }
}

test("owner validates private candidate in memory and leaves exact selected inputs untouched", async () => {
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    "malformed synthetic env canary: ["
  );
  await symlink(join(root, "absent-key"), join(projectDir, "hack.env.key"));
  const before = await readdir(projectDir);
  const binary = await compiler();
  const result = await previewNativeConfigImport({ projectRoot, binary });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    name: "fixture",
    services: { web: { environment: { TOKEN: { default: CANARY } } } },
  });
  const received = JSON.parse(await readFile(receipt, "utf8"));
  expect(JSON.parse(received.raw)).toEqual(result.candidate);
  expect(received.keys).toEqual(["PATH"]);
  expect(received.args).toEqual(["compile"]);
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    CONFIG
  );
  expect(await readFile(join(projectDir, "docker-compose.yml"), "utf8")).toBe(
    COMPOSE
  );
  expect(await readdir(projectDir)).toEqual(before);
  expect(await Bun.file(join(root, "home")).exists()).toBe(false);
  expect(await Bun.file(join(root, "never-read-global")).exists()).toBe(false);
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify(result)).not.toContain("semantic_hash");
});

test("parser refusal bypasses the compiler while retaining inactive field provenance", async () => {
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify({
      services: {
        web: { image: "fixture" },
        inactive: { image: "fixture", profiles: ["qa"], ports: [CANARY] },
      },
    })
  );
  const result = await previewNativeConfigImport({
    projectRoot,
    binary: await compiler(),
  });
  refused(result, "unsupported_field");
  expect(
    result.report.fields.some(
      (field) =>
        field.pointer === "/services/inactive/ports/0" &&
        field.status === "refused"
    )
  ).toBe(true);
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test("compiler refusal never forwards diagnostics, plan, hash or partial authored candidate", async () => {
  const binary = await compiler(
    `console.log(JSON.stringify({transport_version:1,ok:false,diagnostics:[{code:'invalid_image',pointer:'/services/web/image',message:${JSON.stringify(CANARY)},line:1,column:1}]}));process.exit(1);`
  );
  refused(
    await previewNativeConfigImport({ projectRoot, binary }),
    "candidate_compiler_refused"
  );
});

test.each([
  ".env",
  ".hack/.env",
  ".hack/hack.local.json",
])("local/dotenv marker is an explicit unread refusal: %s", async (path) => {
  await symlink(
    join(root, "absent-private-target"),
    resolve(projectRoot, path)
  );
  refused(
    await previewNativeConfigImport({ projectRoot, binary: await compiler() }),
    "local_or_dotenv_input_outside_first_slice"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test.each([
  "root",
  "ancestor",
])("linked/separate Git marker refuses before values or compiler: %s", async (location) => {
  await writeFile(
    join(location === "root" ? projectRoot : root, ".git"),
    `gitdir: ${CANARY}\n`
  );
  refused(
    await previewNativeConfigImport({ projectRoot, binary: await compiler() }),
    "git_file_layout_outside_first_slice"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test.each([
  ".hack/hack.project.json",
  ".hack/hack.toml",
  ".dev/docker-compose.yml",
])("mixed input family refuses exact-root conversion: %s", async (path) => {
  const destination = resolve(projectRoot, path);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, CANARY);
  refused(
    await previewNativeConfigImport({ projectRoot, binary: await compiler() }),
    "unsafe_changed_or_unavailable_input"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test.each([
  "symlink",
  "hardlink",
  "directory",
  "oversized",
  "utf8",
])("unsafe selected input refuses before compiler: %s", async (kind) => {
  const file = join(projectDir, "hack.config.json");
  await rm(file);
  if (kind === "symlink") {
    await symlink(join(projectDir, "docker-compose.yml"), file);
  }
  if (kind === "hardlink") {
    await link(join(projectDir, "docker-compose.yml"), file);
  }
  if (kind === "directory") {
    await mkdir(file);
  }
  if (kind === "oversized") {
    await writeFile(file, " ".repeat(1024 * 1024 + 1));
  }
  if (kind === "utf8") {
    await writeFile(file, new Uint8Array([255]));
  }
  refused(
    await previewNativeConfigImport({ projectRoot, binary: await compiler() }),
    "unsafe_changed_or_unavailable_input"
  );
  expect(await Bun.file(receipt).exists()).toBe(false);
});

test.each([
  [".hack/hack.config.json", `${CONFIG}\n`],
  [".hack/docker-compose.yml", `${COMPOSE}\n`],
  [".hack/hack.local.json", CANARY],
  [".env", CANARY],
  [".hack/hack.project.json", CANARY],
  [".git", CANARY],
  ["../.git", CANARY],
  [".dev/docker-compose.yml", CANARY],
])("changed/added raw input at compiler boundary cannot produce a stale candidate: %s", async (path, text) => {
  const destination = resolve(projectRoot, path);
  const binary = await compiler(
    `await Bun.write(${JSON.stringify(destination)},${JSON.stringify(text)});`
  );
  refused(
    await previewNativeConfigImport({ projectRoot, binary }),
    "unsafe_changed_or_unavailable_input"
  );
});

test("cancellation stops the real compiler and stays redacted", async () => {
  const signal = new AbortController();
  const binary = await compiler("await new Promise(()=>{});");
  const result = previewNativeConfigImport({
    projectRoot,
    binary,
    signal: signal.signal,
  });
  await ready(receipt);
  signal.abort(CANARY);
  await expect(result).rejects.toThrow("cancelled");
  try {
    await result;
  } catch (error) {
    expect(String(error)).not.toContain(CANARY);
  }
});

test("caller option mutation cannot redirect captured selection or compiler", async () => {
  const binary = await compiler("await Bun.sleep(20);");
  const controller = new AbortController();
  const opts = { projectRoot, binary, signal: controller.signal };
  const pending = previewNativeConfigImport(opts);
  opts.projectRoot = join(root, "other");
  opts.binary = join(root, "absent");
  opts.signal = AbortSignal.abort(CANARY);
  const result = await pending;
  expect(result.report.complete).toBe(true);
  expect(await Bun.file(receipt).exists()).toBe(true);
});

test("CLI requires dry-run, reports values-free mappings and preserves files", async () => {
  const binary = await compiler();
  const cwd = resolve(import.meta.dir, "..");
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "index.ts",
        "config",
        "import",
        "--path",
        projectRoot,
        "--json",
        ...args,
      ],
      {
        cwd,
        env: {
          ...process.env,
          HACK_CONFIG_COMPILER_BINARY: binary,
          FORCE_COLOR: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  const without = await run([]);
  expect(without.exit).not.toBe(0);
  expect(without.stdout + without.stderr).toContain("requires --dry-run");
  expect(await Bun.file(receipt).exists()).toBe(false);
  const success = await run(["--dry-run"]);
  expect(success.exit).toBe(0);
  expect(JSON.parse(success.stdout).complete).toBe(true);
  expect(success.stdout + success.stderr).not.toContain(CANARY);
  expect(await readFile(join(projectDir, "docker-compose.yml"), "utf8")).toBe(
    COMPOSE
  );
  expect(await Bun.file(join(projectDir, "hack.project.json")).exists()).toBe(
    false
  );
  expect(
    await Bun.file(join(projectDir, "hack.project.draft.json")).exists()
  ).toBe(false);
});
