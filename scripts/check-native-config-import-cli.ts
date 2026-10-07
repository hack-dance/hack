#!/usr/bin/env bun
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { previewNativeConfigImport } from "../src/lib/native-config-import-preview.ts";

/** Qualify the private mapping and report against the real compiler and relocated CLI. */
const root = resolve(import.meta.dir, "..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "native-import-cli-"))
);
const project = join(directory, "project");
const authoredDir = join(project, ".hack");
const bundle = join(directory, "bundle");
const canary = "private-synthetic-import-value";
const config = JSON.stringify({
  name: "fixture",
  env: { defaultOverlay: "QA" },
  worktree: { autoBranch: false, inheritLocal: true },
});
const workloads = {
  web: {
    image: "example/web:1",
    command: ["app", "--mode", "fixture"],
    entrypoint: [],
    init: false,
    pull_policy: "never",
    restart: "on-failure:3",
    stop_signal: "SIGTERM",
    stop_grace_period: "2s",
    working_dir: "/app",
    environment: { TOKEN: canary, EMPTY: "" },
  },
  inactive: {
    image: "example/optional:1",
    profiles: ["qa"],
    environment: [`TOKEN=${canary}`],
  },
};
const compose = JSON.stringify({ name: "fixture", services: workloads });
let checks = 0;
try {
  await mkdir(authoredDir, { recursive: true });
  await mkdir(bundle);
  await copyFile(join(root, "dist/hack"), join(bundle, "hack"));
  await copyFile(
    process.env.HACK_CONFIG_COMPILER_BINARY ??
      join(root, "dist/hack-config-compiler"),
    join(bundle, "hack-config-compiler")
  );
  await Bun.write(join(authoredDir, "hack.config.json"), config);
  await Bun.write(join(authoredDir, "docker-compose.yml"), compose);
  const names = await readdir(authoredDir);
  const preview = await previewNativeConfigImport({
    projectRoot: project,
    binary: join(bundle, "hack-config-compiler"),
  });
  assert(
    preview.report.complete && preview.candidate !== undefined,
    "real compiler accepts complete mapping"
  );
  assert(
    !JSON.stringify(preview).includes(canary),
    "private candidate never enters serialized report"
  );
  const response = await cli(["--dry-run"]);
  assert(
    response.exit === 0 && response.report.complete === true,
    "relocated CLI accepts exact legacy pair"
  );
  assert(
    response.report.adoption === "not_performed",
    "success does not claim adoption"
  );
  assert(
    JSON.stringify(names) === JSON.stringify(await readdir(authoredDir)),
    "preview creates no selected files"
  );
  assert(
    (await readFile(join(authoredDir, "hack.config.json"), "utf8")) === config,
    "legacy config bytes unchanged"
  );
  assert(
    (await readFile(join(authoredDir, "docker-compose.yml"), "utf8")) ===
      compose,
    "Compose bytes unchanged"
  );
  assert(
    !(await Bun.file(join(directory, "home")).exists()),
    "preview creates no registry/home"
  );
  const usage = await cli([]);
  assert(usage.exit !== 0 && usage.report.ok === false, "non-dry-run refuses");
  await Bun.write(
    join(authoredDir, "docker-compose.yml"),
    JSON.stringify({
      services: {
        web: { image: "example/web:1" },
        inactive: {
          image: "example/optional:1",
          profiles: ["qa"],
          working_dir: "relative-private-path",
        },
      },
    })
  );
  const semantic = await cli(["--dry-run"]);
  assert(
    semantic.exit !== 0 &&
      fields(semantic.report).some(
        (field) => field.code === "candidate_compiler_refused"
      ),
    "compiler validates unsupported path in inactive profile"
  );
  await Bun.write(
    join(authoredDir, "docker-compose.yml"),
    `services: {web: {image: one, image: "${canary}"}}`
  );
  const duplicate = await cli(["--dry-run"]);
  assert(
    duplicate.exit !== 0 &&
      fields(duplicate.report).some((field) => field.code === "duplicate_key"),
    "duplicate source keys refuse without normalized fallback"
  );
  await Bun.write(join(authoredDir, "docker-compose.yml"), compose);
  await Bun.write(join(authoredDir, "hack.local.json"), canary);
  const local = await cli(["--dry-run"]);
  assert(
    local.exit !== 0 &&
      fields(local.report).some(
        (field) => field.code === "local_or_dotenv_input_outside_first_slice"
      ),
    "local input explicitly stays outside first slice"
  );
  console.log(
    `native-config-import-cli: ${checks} checks passed (read-only, real compiler, no runtime effects)`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
  checks++;
}
function fields(report: Record<string, unknown>): Record<string, unknown>[] {
  assert(
    Array.isArray(report.fields) && report.fields.every(isRecord),
    "report has field-only diagnostic objects"
  );
  return report.fields;
}
async function cli(args: readonly string[]) {
  const child = Bun.spawn(
    [
      join(bundle, "hack"),
      "config",
      "import",
      "--path",
      project,
      "--json",
      ...args,
    ],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HACK_HOME: join(directory, "home"),
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
  assert(
    !(stdout + stderr).includes(canary),
    "CLI response contains no authored private literal"
  );
  assert(
    !(stdout + stderr).includes("relative-private-path"),
    "compiler refusal contains no authored private literal"
  );
  const report: unknown = JSON.parse(stdout);
  assert(isRecord(report), "CLI returns a report object");
  assert(
    !(
      Object.hasOwn(report, "candidate") ||
      Object.hasOwn(report, "semantic_hash")
    ),
    "CLI exposes neither private candidate nor compiler identity"
  );
  return { report, exit };
}
