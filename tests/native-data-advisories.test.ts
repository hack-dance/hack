import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findNativeDataAdvisories,
  NATIVE_DATA_CHECK,
  nativeDataCheckResult,
  readNativeDataAdvisories,
} from "../src/lib/native-data-advisories.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const PINNED = `example/database:16@sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function project(
  services: Record<string, unknown>,
  volumes: Record<string, unknown> = { data: {} }
) {
  return { services, volumes };
}

test("no named data volume means no advisory", () => {
  expect(findNativeDataAdvisories(null)).toEqual([]);
  expect(findNativeDataAdvisories({ services: [] })).toEqual([]);
  expect(
    findNativeDataAdvisories(
      project({
        web: { image: "example/web:latest", volumes: ["./src:/app:ro"] },
        tmp: { image: "example/web", volumes: ["/var/cache"] },
        undeclared: { image: "example/web", volumes: ["other:/data"] },
        interpolated: { image: "example/web", volumes: ["${DATA}:/data"] },
      })
    )
  ).toEqual([]);
});

test("a data service without user and on a mutable tag gets both advisories", () => {
  for (const image of [
    "example/database",
    "example/database:latest",
    "registry.example:5000/team/database",
  ]) {
    expect(
      findNativeDataAdvisories(
        project({ db: { image, volumes: ["data:/var/lib/data"] } })
      )
    ).toEqual([
      { code: "native_data_owner_handoff_unqualified", services: ["db"] },
      { code: "native_retained_data_mutable_image", services: ["db"] },
    ]);
  }
});

test("long-syntax and subpath named mounts count as data", () => {
  expect(
    findNativeDataAdvisories(
      project({
        b: {
          image: PINNED,
          volumes: [
            { type: "volume", source: "data", target: "/data", volume: {} },
          ],
        },
        a: {
          image: PINNED,
          volumes: [
            {
              type: "volume",
              source: "data",
              target: "/srv",
              volume: { subpath: "a" },
            },
          ],
        },
      })
    )
  ).toEqual([
    { code: "native_data_owner_handoff_unqualified", services: ["a", "b"] },
  ]);
});

test("explicit user, pinned image, fixed tag or local build clear advisories", () => {
  expect(
    findNativeDataAdvisories(
      project({
        numeric: { image: PINNED, user: "999:999", volumes: ["data:/d"] },
        root: { image: "example/db:16.4", user: "0:0", volumes: ["data:/d"] },
        number: {
          image: `sha256:${"b".repeat(64)}`,
          user: 70,
          volumes: ["data:/d"],
        },
        built: { build: ".", user: "1000", volumes: ["data:/d"] },
      })
    )
  ).toEqual([]);
  expect(
    findNativeDataAdvisories(
      project({
        empty: { image: PINNED, user: " ", volumes: ["data:/d"] },
      })
    )
  ).toEqual([
    { code: "native_data_owner_handoff_unqualified", services: ["empty"] },
  ]);
});

test("an entrypoint override or local build is not an image handoff", () => {
  expect(
    findNativeDataAdvisories(
      project({
        overridden: {
          image: PINNED,
          entrypoint: ["/usr/local/bin/server"],
          volumes: ["data:/d"],
        },
        emptied: { image: PINNED, entrypoint: [], volumes: ["data:/d"] },
        built: { build: { context: "." }, volumes: ["data:/d"] },
      })
    )
  ).toEqual([]);
  expect(
    findNativeDataAdvisories(
      project({
        inherited: { image: PINNED, entrypoint: null, volumes: ["data:/d"] },
      })
    )
  ).toEqual([
    { code: "native_data_owner_handoff_unqualified", services: ["inherited"] },
  ]);
});

test("dependency-cache and disposable-cache volumes are not data", () => {
  expect(
    findNativeDataAdvisories(
      project(
        {
          install: {
            image: "example/installer:latest",
            labels: { "hack.dependencies.cache-volume": "deps" },
            volumes: ["deps:/deps"],
          },
          app: {
            image: "example/app",
            labels: ["unrelated=1"],
            volumes: ["deps:/deps:ro", "scratch:/cache"],
          },
          listed: {
            image: "example/app",
            labels: ["hack.dependencies.cache-volume=listed-deps"],
            volumes: ["listed-deps:/deps"],
          },
        },
        {
          deps: {},
          "listed-deps": {},
          scratch: { "x-hack-disposable-cache": [".cache"] },
        }
      )
    )
  ).toEqual([]);
});

test("the doctor result is a warning with codes and service names only", () => {
  const ok = nativeDataCheckResult([]);
  expect(ok).toMatchObject({
    name: NATIVE_DATA_CHECK,
    status: "ok",
    nativeData: { advisories: [] },
  });
  const advisories = findNativeDataAdvisories(
    project(
      {
        db: { image: "example/private-db", volumes: ["secret-volume:/srv/x"] },
      },
      { "secret-volume": {} }
    )
  );
  const warn = nativeDataCheckResult(advisories);
  expect(warn.status).toBe("warn");
  expect(warn.nativeData.advisories.map((a) => a.code)).toEqual([
    "native_data_owner_handoff_unqualified",
    "native_retained_data_mutable_image",
  ]);
  expect(warn.message).toContain("native_data_owner_handoff_unqualified (db)");
  expect(warn.message).toContain("user:");
  expect(warn.message).toContain("pin a digest");
  for (const value of ["example/private-db", "secret-volume", "/srv/x"]) {
    expect(warn.message).not.toContain(value);
    expect(JSON.stringify(warn.nativeData)).not.toContain(value);
  }
});

async function fixture(compose: Record<string, unknown>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-data-advisories-"))
  );
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(root, "native-home");
  const runtimeDir = join(root, "runtime");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(runtimeDir);
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(composeFile, JSON.stringify(compose));
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "data-advisory-fixture" })
  );
  await writeFile(join(runtimeDir, "hack-relay-guest"), "synthetic relay");
  const binary = join(runtimeDir, "native-runtime");
  // Every runtime request refuses; doctor must still report the static check.
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  const env = privateCliEnv({
    root,
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: binary,
      HACK_NATIVE_HOME: nativeHome,
      HACK_NO_INTERACTIVE: "1",
      HACK_LOGGER: "console",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
    },
  });
  return { root, projectRoot, composeFile, env };
}

test("readNativeDataAdvisories reads the Compose file with native bounds", async () => {
  const f = await fixture(
    project({ db: { image: PINNED, volumes: ["data:/d"] } })
  );
  expect(await readNativeDataAdvisories(f.composeFile)).toEqual([
    { code: "native_data_owner_handoff_unqualified", services: ["db"] },
  ]);
  expect(await readNativeDataAdvisories(join(f.root, "missing.yml"))).toEqual(
    []
  );
});

test(
  "native doctor reports data advisories in JSON without authored values",
  async () => {
    const f = await fixture(
      project(
        { db: { image: "example/private-db", volumes: ["private-data:/x/y"] } },
        { "private-data": {} }
      )
    );
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "--path",
        f.projectRoot,
        "doctor",
        "--json",
      ],
      {
        cwd: f.root,
        env: f.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: SPAWN_TIMEOUT_MS - 5000,
      }
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    const envelope: unknown = JSON.parse(output.slice(output.indexOf("{")));
    expect(envelope).toMatchObject({
      data: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: NATIVE_DATA_CHECK,
            status: "warn",
            nativeData: {
              advisories: [
                {
                  code: "native_data_owner_handoff_unqualified",
                  services: ["db"],
                },
                {
                  code: "native_retained_data_mutable_image",
                  services: ["db"],
                },
              ],
            },
          }),
        ]),
      },
    });
    expect(output).not.toContain("example/private-db");
    expect(output).not.toContain("private-data");
  },
  SPAWN_TIMEOUT_MS
);
