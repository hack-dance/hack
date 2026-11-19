import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeDevInputsFromText,
  hasDevPerformanceDetail,
  sharedSourceInstallsCheck,
} from "../src/lib/doctor-dev-performance.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function project(opts: {
  readonly compose: string;
  readonly dirs: readonly string[];
  readonly files?: readonly string[];
}): Promise<{ root: string; composeFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "hack-shared-source-"));
  roots.push(root);
  await mkdir(join(root, ".hack"), { recursive: true });
  for (const dir of opts.dirs) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const file of opts.files ?? []) {
    await writeFile(join(root, file), "");
  }
  const composeFile = join(root, ".hack", "docker-compose.yml");
  await writeFile(composeFile, opts.compose);
  return { root, composeFile };
}

async function check(
  fixture: { root: string; composeFile: string },
  compose: string,
  localDirectories: readonly string[] = []
) {
  return await sharedSourceInstallsCheck({
    projectRoot: fixture.root,
    composeFile: fixture.composeFile,
    inputs: composeDevInputsFromText({
      file: ".hack/docker-compose.yml",
      text: compose,
    }),
    localDirectories,
  });
}

const BIND = `services:
  web:
    image: node:22
    volumes:
      - ..:/app
  worker:
    image: node:22
    volumes:
      - ..:/app
      - deps:/app/node_modules
  db:
    image: postgres:17
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  deps: {}
  data: {}
`;

test("a dependency directory a service sees through its source bind is named, with the setting to add", async () => {
  const fixture = await project({
    compose: BIND,
    dirs: ["node_modules", ".next"],
  });
  const result = await check(fixture, BIND);
  expect(result.status).toBe("ok");
  expect(result.devPerformance).toEqual({
    kind: "shared_source_installs",
    services: [
      {
        service: "web",
        directory: "node_modules",
        target: "/app/node_modules",
      },
      { service: "web", directory: ".next", target: "/app/.next" },
      // worker already mounts a volume at node_modules.
      { service: "worker", directory: ".next", target: "/app/.next" },
    ],
  });
  expect(result.message).toContain(
    '"localDirectories": ["node_modules",".next"]'
  );
  expect(hasDevPerformanceDetail(result)).toBe(true);
});

test("declared local directories, missing directories and binds outside the checkout are not reported", async () => {
  const outside = `services:
  web:
    image: node:22
    volumes:
      - ..:/app
      - /tmp:/scratch
`;
  const fixture = await project({ compose: outside, dirs: ["node_modules"] });
  const result = await check(fixture, outside, ["node_modules"]);
  expect(result.devPerformance).toEqual({
    kind: "shared_source_installs",
    services: [],
  });
  expect(hasDevPerformanceDetail(result)).toBe(false);
});

test("Rust target counts only beside Cargo.toml", async () => {
  const compose = `services:
  api:
    image: rust:1
    volumes:
      - ..:/src
`;
  const without = await project({ compose, dirs: ["target"] });
  expect((await check(without, compose)).devPerformance).toMatchObject({
    services: [],
  });
  const withCargo = await project({
    compose,
    dirs: ["target"],
    files: ["Cargo.toml"],
  });
  expect((await check(withCargo, compose)).devPerformance).toMatchObject({
    services: [{ service: "api", directory: "target", target: "/src/target" }],
  });
});

test("a bind of the directory itself is still the shared source", async () => {
  const compose = `services:
  web:
    image: node:22
    volumes:
      - ..:/app
      - ../node_modules:/app/node_modules
`;
  const fixture = await project({ compose, dirs: ["node_modules"] });
  expect((await check(fixture, compose)).devPerformance).toMatchObject({
    services: [
      {
        service: "web",
        directory: "node_modules",
        target: "/app/node_modules",
      },
    ],
  });
});

test("an invalid localDirectories gets its own note instead of advice", async () => {
  const fixture = await project({ compose: BIND, dirs: ["node_modules"] });
  const result = await sharedSourceInstallsCheck({
    projectRoot: fixture.root,
    composeFile: fixture.composeFile,
    inputs: composeDevInputsFromText({
      file: ".hack/docker-compose.yml",
      text: BIND,
    }),
    localDirectories: [],
    localDirectoriesError: "Project localDirectories must be a list.",
  });
  expect(result.status).toBe("ok");
  expect(result.message).toBe(
    "Note: localDirectories in .hack/hack.config.json is invalid, so it was not compared, and hack up refuses it: Project localDirectories must be a list."
  );
  expect(hasDevPerformanceDetail(result)).toBe(true);
});

test("the advice names the Compose backend and says native does not apply it", async () => {
  const fixture = await project({ compose: BIND, dirs: ["node_modules"] });
  const result = await check(fixture, BIND);
  expect(result.message).toContain("On the Compose backend");
  expect(result.message).toContain(
    "The native backend does not apply localDirectories yet."
  );
});

test("doctor flags only what up would move: a volume at the path, even with a trailing slash, is not flagged", async () => {
  const compose = `services:
  web:
    image: node:22
    volumes:
      - ..:/app
      - nm:/app/node_modules/
volumes:
  nm: {}
`;
  const fixture = await project({ compose, dirs: ["node_modules"] });
  expect((await check(fixture, compose)).devPerformance).toEqual({
    kind: "shared_source_installs",
    services: [],
  });
});

test("doctor skips a service whose mount target comes from a variable, as up does", async () => {
  const compose = `services:
  web:
    image: node:22
    volumes:
      - ..:/app
      - nm:\${NM_DIR:-/app/node_modules}
volumes:
  nm: {}
`;
  const fixture = await project({ compose, dirs: ["node_modules"] });
  expect((await check(fixture, compose)).devPerformance).toEqual({
    kind: "shared_source_installs",
    services: [],
  });
});
