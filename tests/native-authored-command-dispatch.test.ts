import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

const roots: string[] = [];
const PRIVATE = "synthetic-private-dispatch-diagnostic";
const realCompiler = resolve(
  process.env.HACK_CONFIG_COMPILER_BINARY ?? "dist/hack-config-compiler"
);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-dispatch-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await mkdir(join(root, "candidate"), { mode: 0o700 });
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    "{malformed authored input"
  );
  const native = join(root, "native");
  await Bun.write(
    native,
    `#!${process.execPath}
await Bun.write(${JSON.stringify(join(root, "runtime-called"))}, "unexpected-runtime-call");
process.exit(2);
`
  );
  await chmod(native, 0o700);
  const compiler = join(root, "compiler");
  await Bun.write(
    compiler,
    `#!${process.execPath}
await Bun.write(${JSON.stringify(join(root, "compiler-called"))}, "pure-compiler-call");
if(process.argv[2]==='--protocol')console.log(JSON.stringify({transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1,routing_plan_version:1,host_env_plan_version:1,endpoint_plan_version:1}));
else console.log(JSON.stringify({transport_version:1,ok:false,diagnostics:[{code:'invalid_json',pointer:'/',document:'project',message:${JSON.stringify(PRIVATE)}}]}));
`
  );
  await chmod(compiler, 0o700);
  return { root, native, compiler };
}
async function invoke(opts: {
  readonly selected: Awaited<ReturnType<typeof fixture>>;
  readonly args: readonly string[];
  readonly backend?: string;
  readonly logger?: "console";
}) {
  const { root, native, compiler } = opts.selected;
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "--path",
      root,
      ...opts.args,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CI: "1",
        HACK_EXECUTION_MODE: "ci",
        HACK_HOME: join(root, "home"),
        HACK_CONFIG_COMPILER_BINARY: compiler,
        HACK_NATIVE_BINARY: native,
        HACK_NATIVE_HOME: join(root, "candidate"),
        ...(opts.logger === undefined ? {} : { HACK_LOGGER: opts.logger }),
        ...(opts.backend === undefined
          ? {}
          : { HACK_RUNTIME_BACKEND: opts.backend }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout.length + stderr.length).toBeLessThan(64 * 1024);
    expect(stdout + stderr).not.toContain(PRIVATE);
    expect(await Bun.file(join(root, "runtime-called")).exists()).toBe(false);
    expect(await readdir(join(root, "candidate"))).toEqual([]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

test.each([
  { args: ["up", "--detach"] },
  { args: ["up", "--json"] },
])("source CLI native %j refuses before compiler or runtime work", async ({
  args,
}) => {
  const selected = await fixture();
  const value = await invoke({ selected, args, backend: "native" });
  expect(value.code).toBe(1);
  expect(value.stdout + value.stderr).toContain("E_NATIVE_PROJECT_UNSUPPORTED");
  expect(value.stdout + value.stderr).toContain(
    "whole-project foreground up, ps, owner-mediated down, finite single-service logs --no-follow, or explicit stored-generation down --recover on macOS"
  );
  expect(await Bun.file(join(selected.root, "compiler-called")).exists()).toBe(
    false
  );
  expect(await readdir(join(selected.root, ".hack"))).toEqual([
    "hack.project.json",
  ]);
});

test("source CLI omitted backend retains the existing Compose foreground refusal", async () => {
  const selected = await fixture();
  const value = await invoke({ selected, args: ["up"] });
  expect(value.code).toBe(1);
  expect(value.stdout + value.stderr).toContain(
    "whole-project detached startup"
  );
  expect(await Bun.file(join(selected.root, "compiler-called")).exists()).toBe(
    false
  );
  expect(await readdir(join(selected.root, ".hack"))).toEqual([
    "hack.project.json",
  ]);
});

test("source CLI mixed authored families refuse before native dispatch", async () => {
  const selected = await fixture();
  await Bun.write(
    join(selected.root, ".hack/docker-compose.yml"),
    "services: {}\n"
  );
  const value = await invoke({ selected, args: ["up"], backend: "native" });
  expect(value.code).toBe(1);
  expect(value.stdout + value.stderr).toContain("E_NATIVE_PROJECT_CONFLICT");
  expect(await Bun.file(join(selected.root, "compiler-called")).exists()).toBe(
    false
  );
});

const macTest = process.platform === "darwin" ? test : test.skip;
macTest(
  "ordinary source CLI down with no live hook owner refuses without compiler or runtime work",
  async () => {
    const selected = await fixture();
    const value = await invoke({ selected, args: ["down"], backend: "native" });
    expect(value.code).toBe(1);
    expect(value.stdout + value.stderr).toContain("E_LIFECYCLE_FAILED");
    expect(
      await Bun.file(join(selected.root, "compiler-called")).exists()
    ).toBe(false);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([
      "hack.project.json",
    ]);
  }
);

macTest.each([
  { name: "omitted", args: [], code: "E_LIFECYCLE_FAILED" },
  {
    name: "explicit-empty",
    args: ["--profile", ""],
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
  },
  {
    name: "explicit-named",
    args: ["--profile", "dev"],
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
  },
])(
  "source CLI recovery keeps $name profile selection without input or runtime work",
  async ({ args, code }) => {
    const selected = await fixture();
    await Bun.write(
      join(selected.root, ".hack/hack.env.default.yaml"),
      `values: [${PRIVATE}`
    );
    const value = await invoke({
      selected,
      args: ["down", "--recover", ...args],
      backend: "native",
      logger: "console",
    });
    expect(value.code).toBe(1);
    expect(value.stdout + value.stderr).toMatch(
      new RegExp(`(?:^|\\n)ERROR: ${code}\\b`)
    );
    expect(value.stdout + value.stderr).not.toContain(
      code === "E_LIFECYCLE_FAILED"
        ? "E_NATIVE_PROJECT_UNSUPPORTED"
        : "E_LIFECYCLE_FAILED"
    );
    expect(
      await Bun.file(join(selected.root, "compiler-called")).exists()
    ).toBe(false);
    expect(await readdir(join(selected.root, ".hack"))).toEqual([
      "hack.env.default.yaml",
      "hack.project.json",
    ]);
  }
);
const unsupportedFiles = [
  { name: "configs-empty", files: { configs: {} } },
  { name: "secrets-empty", files: { secrets: {} } },
  {
    name: "files-inactive",
    files: { configs: { unused: { file: "must-not-read.txt" } } },
  },
] as const;
macTest.each(
  unsupportedFiles.flatMap((selection) =>
    ["malformed-metadata", "invalid-ciphertext"].map((managed) => ({
      ...selection,
      managed,
    }))
  )
)(
  "source CLI $name with $managed preserves early unsupported classification before environment acquisition",
  async ({ files, managed }) => {
    const selected = await fixture();
    await Bun.write(
      join(selected.root, ".hack/hack.project.json"),
      JSON.stringify({
        schema_version: 1,
        name: "file-refusal-control",
        worktree: { inherit_local: false, auto_branch: false },
        services: {
          web: {
            image: `sha256:${"a".repeat(64)}`,
            environment: { TOKEN: { env_ref: "TOKEN" } },
          },
        },
        ...files,
      })
    );
    // Neither metadata parsing nor value resolution may supersede the raw file fence.
    await Bun.write(
      join(selected.root, ".hack/hack.env.default.yaml"),
      managed === "malformed-metadata"
        ? `values: [${PRIVATE}`
        : JSON.stringify({
            version: 1,
            environment: "default",
            secretsprovider: "project_key",
            values: { global: { TOKEN: { secure: `v1:${PRIVATE}` } } },
          })
    );
    const value = await invoke({
      selected: { ...selected, compiler: realCompiler },
      args: ["up", "--env", "base"],
      backend: "native",
      logger: "console",
    });
    expect(value.code).toBe(1);
    expect(value.stdout + value.stderr).toMatch(
      /^ERROR: E_NATIVE_PROJECT_UNSUPPORTED:/
    );
    expect(value.stdout + value.stderr).not.toContain("E_STARTUP_INCOMPLETE");
    expect(value.stdout + value.stderr).toContain(
      "no native consumer was started"
    );
    expect(
      await readdir(join(selected.root, ".hack/.internal/native-authored-runs"))
    ).toEqual([".gitignore"]);
  }
);
macTest.each([
  { option: "base", overlay: "base", metadata: null },
  { option: undefined, overlay: "inherit", metadata: "qa" },
  { option: " QA ", overlay: { named: "qa" }, metadata: "qa" },
])(
  "source CLI env $option binds the documented selection into the native source before values",
  async ({ option, overlay, metadata }) => {
    const selected = await fixture();
    await Bun.write(
      join(selected.root, ".hack/hack.project.json"),
      JSON.stringify({
        schema_version: 1,
        name: "overlay-control",
        environment: { default_overlay: "qa" },
        worktree: { inherit_local: false, auto_branch: false },
        services: { web: { image: `sha256:${"a".repeat(64)}` } },
      })
    );
    const ciphertext = "v1:synthetic-unread-overlay-secret";
    for (const name of ["default", "qa"]) {
      await Bun.write(
        join(selected.root, `.hack/hack.env.${name}.yaml`),
        JSON.stringify({
          version: 1,
          environment: name,
          secretsprovider: "project_key",
          values: {
            global:
              name === "default"
                ? { TOKEN: { secure: ciphertext } }
                : { QA_ONLY: { secure: ciphertext } },
          },
        })
      );
    }
    const captured = join(selected.root, "native-source-captured.json");
    await Bun.write(
      selected.native,
      `#!${process.execPath}
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--candidate-root'||args[2]!=='graph'||args[3]!=='native'||args[4]!=='plan'||args[5]!=='--source-file'||args[7]!=='--json') {
 await Bun.write(${JSON.stringify(join(selected.root, "runtime-called"))}, 'unexpected-effect'); process.exit(2);
}
await Bun.write(${JSON.stringify(captured)}, await Bun.file(args[6]).text(), {mode:0o600});
console.error(JSON.stringify({code:'native_graph_subset'}));process.exit(1);
`
    );
    const value = await invoke({
      selected: { ...selected, compiler: realCompiler },
      args: ["up", ...(option === undefined ? [] : ["--env", option])],
      backend: "native",
    });
    expect(value.code).toBe(1);
    expect(value.stdout + value.stderr).toContain(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
    const text = await Bun.file(captured).text();
    expect(text).not.toContain(ciphertext);
    const envelope: unknown = JSON.parse(text);
    if (
      !(
        isRecord(envelope) &&
        isRecord(envelope.env_metadata) &&
        isRecord(envelope.env_metadata.workloads) &&
        isRecord(envelope.env_metadata.workloads.web)
      )
    ) {
      throw new Error("Fixture requires the captured symbolic source envelope");
    }
    expect(envelope.project).toBe(selected.root);
    expect(envelope.overlay).toEqual(overlay);
    expect(envelope.env_metadata.overlay).toBe(metadata);
    expect(envelope.env_metadata.workloads.web.TOKEN).toEqual({
      scope: "global",
      secret: true,
    });
    expect(Object.hasOwn(envelope.env_metadata.workloads.web, "QA_ONLY")).toBe(
      metadata !== null
    );
    expect(
      await readdir(join(selected.root, ".hack/.internal/native-authored-runs"))
    ).toEqual([".gitignore"]);
  }
);

macTest(
  "source CLI foreground native up reaches pure compilation and redacts refusal before runtime",
  async () => {
    const selected = await fixture();
    const value = await invoke({ selected, args: ["up"], backend: "native" });
    expect(value.code).toBe(1);
    expect(value.stdout + value.stderr).toContain(
      "no native consumer was started"
    );
    expect(value.stdout + value.stderr).toContain("E_STARTUP_INCOMPLETE");
    expect(value.stdout + value.stderr).not.toContain(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
    expect(
      await Bun.file(join(selected.root, "compiler-called")).exists()
    ).toBe(true);
    const files = await readdir(
      join(selected.root, ".hack/.internal/native-authored-runs")
    );
    expect(files.filter((file) => file.endsWith(".json"))).toEqual([]);
    expect(files.filter((file) => file.endsWith(".lock"))).toEqual([]);
  }
);
