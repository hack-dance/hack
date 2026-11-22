import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeSetupInspection } from "./helpers/native-setup-inspection.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * `hack doctor` on the native backend, through the real CLI, for a project and
 * a native home with and without the image builder.
 *
 * The stub runtime records every request and answers only the read-only setup
 * inspection, so nothing here starts a runtime, a VM or a download. Every name
 * and value is synthetic.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const IMAGE = `sha256:${"e".repeat(64)}`;
const INSPECT = "runtime setup inspect --json";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function doctor(opts: {
  readonly compose: Record<string, unknown>;
  readonly builder: "prepared" | "not_prepared";
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "doctor-native-builder-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const runtimeDir = join(root, "runtime");
  const calls = join(root, "calls");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(join(root, "native-home"), { mode: 0o700 });
  await mkdir(runtimeDir);
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    JSON.stringify(opts.compose)
  );
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({ name: "doctor-builder-fixture" })
  );
  await writeFile(join(runtimeDir, "hack-relay-guest"), "synthetic relay");
  const inspection = {
    ...nativeSetupInspection(),
    pins: [
      ...nativeSetupInspection().pins,
      {
        url: "https://example.invalid/builder.bin",
        size_bytes: 7,
        archive_sha256: "b".repeat(64),
      },
    ],
    builder: {
      state: opts.builder,
      file: "builder.bin",
      directory: ".hack-local/providers/builder-1.0.0",
      record: ".hack-local/providers/builder.json",
    },
  };
  const binary = join(runtimeDir, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
shift 2
printf '%s\\n' "$*" >> '${calls}'
if [ "$*" = '${INSPECT}' ]; then
  printf '%s\\n' '${JSON.stringify(inspection)}'
  exit 0
fi
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  const child = Bun.spawn([process.execPath, entrypoint, "doctor", "--json"], {
    cwd: project,
    env: privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: join(root, "native-home"),
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const envelope = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
    readonly ok: boolean;
    readonly data: {
      readonly checks: readonly Record<string, unknown>[];
    };
  };
  const requests = (await readFile(calls, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  return {
    envelope,
    check: envelope.data.checks.find(
      (found) => found.id === "native image builder"
    ),
    requests,
  };
}

const builds = {
  services: { web: { build: "." }, db: { image: IMAGE } },
};

test(
  "native doctor warns, with the setup remedy, for a project that builds images on a home without the builder",
  async () => {
    const result = await doctor({ compose: builds, builder: "not_prepared" });
    // A finding in a doctor run that itself worked.
    expect(result.envelope.ok).toBe(true);
    expect(result.check).toMatchObject({
      status: "warn",
      area: "native",
      scope: "project",
      detail:
        "1 service builds an image, but the image builder is not installed in this native home, so native up cannot build it. Run hack native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs.",
      fix: { kind: "manual", args: [] },
      nativeBuilder: { buildServices: 1, builder: "not_prepared" },
    });
    // Doctor asked for the read-only inspection once and never ran setup.
    expect(
      result.requests.filter((request) => request.includes("setup"))
    ).toEqual([INSPECT]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native doctor is ok when the builder is prepared, and asks nothing for a project without build services",
  async () => {
    const prepared = await doctor({ compose: builds, builder: "prepared" });
    expect(prepared.check).toMatchObject({
      status: "ok",
      detail:
        "1 service builds an image; the image builder is installed in this native home.",
      nativeBuilder: { buildServices: 1, builder: "prepared" },
    });
    expect(
      prepared.requests.filter((request) => request.includes("setup"))
    ).toEqual([INSPECT]);

    // No build service: no finding, and the runtime is not asked about its builder
    // even though this home has none.
    const imagesOnly = await doctor({
      compose: { services: { web: { image: IMAGE } } },
      builder: "not_prepared",
    });
    expect(imagesOnly.check).toMatchObject({
      status: "ok",
      detail:
        "No service builds an image, so this project does not need the native image builder.",
      nativeBuilder: { buildServices: 0, builder: "not_checked" },
    });
    expect(
      imagesOnly.requests.filter((request) => request.includes("setup"))
    ).toEqual([]);
  },
  SPAWN_TIMEOUT_MS * 2
);
