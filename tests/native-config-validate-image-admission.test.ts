import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  NATIVE_GRAPH_ADMISSION_CODE,
  NATIVE_GRAPH_ADMISSION_MESSAGE,
  nativeConsumerAdmitsImages,
} from "../src/lib/native-authored-image-admission.ts";

/**
 * HACK-1300: with the native backend selected, `config validate` refuses a
 * selected image that the native consumer would refuse at plan and serve.
 * Every CLI case uses a stub compiler and a temporary HOME; nothing reaches a
 * runtime, registry, Docker socket or the real home directory.
 */
const root = resolve(import.meta.dir, "..");
/** Each case spawns the source CLI; its cold start can exceed bun's default. */
const CLI_TIMEOUT_MS = 30_000;
const CONTENT_ID = `sha256:${"d".repeat(64)}`;
const DIGEST = `docker.io/library/busybox@sha256:${"e".repeat(64)}`;
let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hack-native-validate-image-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function plan(images: Readonly<Record<string, string>>, jobs = {}) {
  return {
    plan_version: 1,
    worktree: { auto_branch: true, inherit_local: true },
    services: Object.fromEntries(
      Object.entries(images).map(([name, image]) => [name, { image }])
    ),
    jobs,
  };
}

test("only sha256 content IDs of selected workloads are admitted", () => {
  expect(nativeConsumerAdmitsImages(plan({ web: CONTENT_ID }))).toBe(true);
  expect(
    nativeConsumerAdmitsImages(plan({}, { seed: { image: CONTENT_ID } }))
  ).toBe(true);
  // Build-only workloads are the native planner's own subset refusal.
  expect(
    nativeConsumerAdmitsImages(plan({}, { seed: { build: { context: "." } } }))
  ).toBe(true);
  for (const image of [
    DIGEST,
    `busybox@sha256:${"e".repeat(64)}`,
    "busybox:1.37",
    "busybox",
    `sha256:${"D".repeat(64)}`,
    `sha256:${"d".repeat(63)}`,
    ` ${CONTENT_ID}`,
  ]) {
    expect(nativeConsumerAdmitsImages(plan({ web: image }))).toBe(false);
    expect(
      nativeConsumerAdmitsImages(plan({ web: CONTENT_ID }, { seed: { image } }))
    ).toBe(false);
  }
  for (const malformed of [
    null,
    [],
    { services: [] },
    { services: { web: null } },
    { services: { web: { image: 1 } } },
  ]) {
    expect(nativeConsumerAdmitsImages(malformed)).toBe(false);
  }
});

test("the TypeScript refusal is byte-identical to the native lowering refusal", async () => {
  const source = await Bun.file(
    join(root, "packages/runtime-core/src/provider/graph/native/mod.rs")
  ).text();
  expect(source).toContain(
    `"${NATIVE_GRAPH_ADMISSION_CODE}",\n        "${NATIVE_GRAPH_ADMISSION_MESSAGE}",`
  );
});

async function runValidate(opts: {
  readonly backend?: string;
  readonly images: Readonly<Record<string, string>>;
  readonly project?: boolean;
  readonly json?: boolean;
}) {
  const compiler = join(directory, "compiler");
  const file = join(directory, "input.json");
  const home = join(directory, "home");
  await mkdir(home);
  await Bun.write(file, '{"schema_version":1,"name":"example"}');
  if (opts.project) {
    await mkdir(join(directory, ".hack"));
    await Bun.write(
      join(directory, ".hack/hack.project.json"),
      '{"schema_version":1,"name":"example"}'
    );
  }
  const response = {
    transport_version: 1,
    ok: true,
    plan: plan(opts.images),
    semantic_hash: "a".repeat(64),
    ...(opts.project
      ? {
          declared_workloads: Object.fromEntries(
            Object.keys(opts.images).map((name) => [name, "service"])
          ),
          local_resolution: {
            overlay: null,
            origin: "project",
            auto_branch: true,
            inherit_local: true,
            resolution_hash: "b".repeat(64),
          },
        }
      : {}),
  };
  await Bun.write(
    compiler,
    `#!${process.execPath}\nif (process.argv[2] === '--protocol') { console.log('{"transport_version":1,"authored_version":1,"plan_version":1,"resolve_version":1,"local_version":1,"env_plan_version":1}'); } else { console.log(${JSON.stringify(JSON.stringify(response))}); }`
  );
  await chmod(compiler, 0o755);
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "index.ts"),
      "config",
      "validate",
      ...(opts.project ? [] : ["--file", file]),
      ...(opts.json === false ? [] : ["--json"]),
    ],
    {
      cwd: directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        HACK_LOGGER: "console",
        HACK_CONFIG_COMPILER_BINARY: compiler,
        ...(opts.backend === undefined
          ? {}
          : { HACK_RUNTIME_BACKEND: opts.backend }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit, home };
}

test.each([
  ["repository digest, explicit file", DIGEST, false],
  ["repository digest, discovered project", DIGEST, true],
  ["registry tag, explicit file", "busybox:1.37", false],
])(
  "native backend refuses a %s closed, before any state",
  async (_name, image, project) => {
    const result = await runValidate({
      backend: "native",
      images: { web: image },
      project,
    });
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      transport_version: 1,
      ok: false,
      error: {
        code: NATIVE_GRAPH_ADMISSION_CODE,
        message: NATIVE_GRAPH_ADMISSION_MESSAGE,
      },
    });
    expect(result.stdout + result.stderr).not.toContain("busybox");
    // No runtime, registry or project state was created: only the fixture remains.
    expect((await readdir(directory)).sort()).toEqual(
      [...(project ? [".hack"] : []), "compiler", "home", "input.json"].sort()
    );
    if (project) {
      expect(await readdir(join(directory, ".hack"))).toEqual([
        "hack.project.json",
      ]);
    }
    // The temporary HOME holds at most Bun's own transpiler cache, never Hack state.
    expect(
      (await readdir(result.home, { recursive: true })).every((name) =>
        name.startsWith("Library")
      )
    ).toBe(true);
  },
  CLI_TIMEOUT_MS
);

test(
  "native human refusal is one closed line without help or stack",
  async () => {
    const result = await runValidate({
      backend: "native",
      images: { web: DIGEST },
      json: false,
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${NATIVE_GRAPH_ADMISSION_CODE}: ${NATIVE_GRAPH_ADMISSION_MESSAGE}\n`
    );
  },
  CLI_TIMEOUT_MS
);

test.each([
  ["unset backend, repository digest", undefined, DIGEST],
  ["compose backend, repository digest", "compose", DIGEST],
  ["native backend, content ID", "native", CONTENT_ID],
])(
  "control: %s stays valid",
  async (_name, backend, image) => {
    const result = await runValidate({ backend, images: { web: image } });
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      plan: { services: { web: { image } } },
    });
  },
  CLI_TIMEOUT_MS
);
