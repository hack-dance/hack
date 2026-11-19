import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localDirectoriesNotices,
  localDirectoriesOverride,
  localDirectoryVolumeName,
  parseLocalDirectories,
  planLocalDirectories,
  withLocalDirectoriesOverride,
} from "../src/lib/local-directories.ts";
import { parseProjectConfigRecord } from "../src/lib/project.ts";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";

const ROOT = "/work/app";
const COMPOSE_DIR = "/work/app/.hack";

const VALID = [
  "node_modules",
  "apps/web/.next",
  "dist",
  "packages/ui/node_modules",
  ".turbo",
];
const INVALID = [
  "",
  "/abs",
  "../outside",
  "a/../b",
  "./node_modules",
  ".git/hooks",
  ".hack",
  "a//b",
  "has space",
  "dist/",
];

test("parseLocalDirectories accepts relative checkout paths as written", () => {
  expect(parseLocalDirectories(VALID)).toEqual({
    entries: [
      "node_modules",
      "apps/web/.next",
      "dist",
      "packages/ui/node_modules",
      ".turbo",
    ],
  });
});

test("parseLocalDirectories refuses unsafe, duplicate, nested and oversized lists", () => {
  for (const entry of INVALID) {
    expect(parseLocalDirectories([entry])).toHaveProperty("error");
  }
  expect(parseLocalDirectories(["a", "a"])).toHaveProperty("error");
  expect(parseLocalDirectories(["apps", "apps/web"])).toHaveProperty("error");
  expect(parseLocalDirectories("node_modules")).toHaveProperty("error");
  expect(
    parseLocalDirectories(Array.from({ length: 33 }, (_, i) => `d${i}`))
  ).toHaveProperty("error");
});

test("an invalid setting is a config error, never silently dropped", () => {
  const config = parseProjectConfigRecord(
    { name: "demo", localDirectories: ["../outside"] },
    "/work/app/.hack/hack.config.json"
  );
  expect(config.localDirectories).toBeUndefined();
  expect(config.localDirectoriesError).toContain("localDirectories");
  // Still a parse error, so doctor, autostart and views see it.
  expect(config.parseError).toContain("localDirectories");
});

test("the editor schema accepts and rejects the same entries as the parser", () => {
  const schema = JSON.parse(renderProjectConfigSchemaJson()) as {
    properties: Record<
      string,
      { items?: { pattern?: string }; maxItems?: number }
    >;
  };
  const field = schema.properties.localDirectories;
  expect(field?.maxItems).toBe(32);
  const pattern = new RegExp(field?.items?.pattern ?? "^$");
  for (const entry of VALID) {
    expect({ entry, ok: pattern.test(entry) }).toEqual({ entry, ok: true });
  }
  for (const entry of INVALID.filter((value) => value !== "")) {
    expect({ entry, ok: pattern.test(entry) }).toEqual({ entry, ok: false });
  }
});

function plan(compose: unknown, entries: readonly string[]) {
  return planLocalDirectories({
    compose,
    composeDir: COMPOSE_DIR,
    projectRoot: ROOT,
    entries,
  });
}

test("each service that binds the checkout gets the same volume at its own path", () => {
  const result = plan(
    {
      services: {
        deps: { volumes: ["..:/workspace"] },
        web: { volumes: [{ type: "bind", source: "..", target: "/app" }] },
        api: { volumes: ["../apps/api:/srv:ro"] },
        db: { volumes: ["data:/var/lib/postgresql/data"] },
      },
    },
    ["node_modules", "apps/api/dist"]
  );
  const volume = localDirectoryVolumeName("node_modules");
  expect(result.services.deps).toEqual([
    {
      entry: "node_modules",
      volume,
      target: "/workspace/node_modules",
      readOnly: false,
    },
    {
      entry: "apps/api/dist",
      volume: localDirectoryVolumeName("apps/api/dist"),
      target: "/workspace/apps/api/dist",
      readOnly: false,
    },
  ]);
  expect(result.services.web?.[0]).toMatchObject({
    volume,
    target: "/app/node_modules",
  });
  // A read-only source bind gets a read-only volume; db binds no source.
  expect(result.services.api).toEqual([
    {
      entry: "apps/api/dist",
      volume: localDirectoryVolumeName("apps/api/dist"),
      target: "/srv/dist",
      readOnly: true,
    },
  ]);
  expect(result.services.db).toBeUndefined();
  expect(result.unmatched).toEqual([]);
});

test("an existing mount at the target is kept, except a bind of that same directory", () => {
  const result = plan(
    {
      services: {
        web: { volumes: ["..:/app", "deps:/app/node_modules"] },
        anon: { volumes: ["..:/app", "/app/node_modules"] },
        host: { volumes: ["..:/app", "../node_modules:/app/node_modules"] },
        other: { volumes: ["..:/app", "../vendor:/app/node_modules"] },
      },
    },
    ["node_modules"]
  );
  expect(result.services.web).toBeUndefined();
  expect(result.services.anon).toBeUndefined();
  expect(result.services.other).toBeUndefined();
  expect(result.services.host?.[0]?.target).toBe("/app/node_modules");
  expect(result.kept.map((item) => item.service).sort()).toEqual([
    "anon",
    "other",
    "web",
  ]);
  expect(localDirectoriesNotices(result)).toContain(
    "localDirectories: service web already mounts /app/node_modules; that mount is kept for node_modules."
  );
});

test("an entry no source bind covers is reported and mounts nothing", () => {
  const result = plan({ services: { web: { volumes: ["../web:/app"] } } }, [
    "node_modules",
  ]);
  expect(result.services).toEqual({});
  expect(result.unmatched).toEqual(["node_modules"]);
  expect(localDirectoriesOverride(result)).toBeNull();
  expect(localDirectoriesNotices(result)).toEqual([
    "localDirectories: no service's source bind in the Compose file shows node_modules; nothing kept local for it (mounts from variables, extends, include or other -f files are not read).",
  ]);
});

test("a home-relative bind never maps a checkout path", () => {
  const result = plan({ services: { web: { volumes: ["~/src:/app"] } } }, [
    "node_modules",
  ]);
  expect(result.unmatched).toEqual(["node_modules"]);
});

test("the override declares each volume once with its labels", () => {
  const override = localDirectoriesOverride(
    plan(
      {
        services: {
          deps: { volumes: ["..:/app"] },
          web: { volumes: ["..:/app:ro"] },
        },
      },
      ["node_modules"]
    )
  );
  const volume = localDirectoryVolumeName("node_modules");
  expect(override).toEqual({
    services: {
      deps: {
        volumes: [
          { type: "volume", source: volume, target: "/app/node_modules" },
        ],
      },
      web: {
        volumes: [
          {
            type: "volume",
            source: volume,
            target: "/app/node_modules",
            read_only: true,
          },
        ],
      },
    },
    volumes: {
      [volume]: {
        labels: {
          "hack.local-directory": "node_modules",
          "hack.cache.disposable": "true",
        },
      },
    },
  });
});

test("volume names are stable, Compose-safe and distinct per entry", () => {
  const name = localDirectoryVolumeName("apps/web/.next");
  expect(name).toMatch(/^hack-local-apps-web-next-[0-9a-f]{8}$/);
  expect(localDirectoryVolumeName("apps/web/.next")).toBe(name);
  expect(localDirectoryVolumeName("apps/web/next")).not.toBe(name);
});

test("the replaced bind's own access mode wins over a covering ancestor's", () => {
  // Source read-only, dependencies writable (an installer layout).
  const result = plan(
    {
      services: {
        deps: {
          volumes: ["..:/app:ro", "../node_modules:/app/node_modules:rw"],
        },
        // And the other way round.
        web: { volumes: ["..:/app", "../node_modules/:/app/node_modules/:ro"] },
      },
    },
    ["node_modules"]
  );
  expect(result.services.deps).toEqual([
    {
      entry: "node_modules",
      volume: localDirectoryVolumeName("node_modules"),
      target: "/app/node_modules",
      readOnly: false,
    },
  ]);
  expect(result.services.web?.[0]?.readOnly).toBe(true);
  expect(result.kept).toEqual([]);
});

test("a path hidden by a more specific mount shows something else and is left alone", () => {
  const result = plan(
    {
      services: {
        // /app/packages shows vendor/, not the checkout's packages/.
        web: { volumes: ["..:/app", "../vendor:/app/packages"] },
        // A named volume over /app/packages hides it as well.
        api: { volumes: ["..:/app", "pkgs:/app/packages"] },
        // A bind of the declared parent itself still shows the entry.
        ui: { volumes: ["..:/app", "../packages:/app/packages"] },
      },
    },
    ["packages/ui/node_modules"]
  );
  expect(result.services.web).toBeUndefined();
  expect(result.services.api).toBeUndefined();
  expect(result.services.ui).toEqual([
    {
      entry: "packages/ui/node_modules",
      volume: localDirectoryVolumeName("packages/ui/node_modules"),
      target: "/app/packages/ui/node_modules",
      readOnly: false,
    },
  ]);
  expect(result.kept).toEqual([]);
  expect(result.unmatched).toEqual([]);
  expect(result.hidden).toEqual([
    {
      service: "web",
      entry: "packages/ui/node_modules",
      target: "/app/packages/ui/node_modules",
      by: "/app/packages",
    },
    {
      service: "api",
      entry: "packages/ui/node_modules",
      target: "/app/packages/ui/node_modules",
      by: "/app/packages",
    },
  ]);
  expect(localDirectoriesNotices(result)).toContain(
    "localDirectories: service web mounts something else at /app/packages, so packages/ui/node_modules is not visible at /app/packages/ui/node_modules; nothing mounted there."
  );
});

test("existing mount targets match with or without a trailing slash", () => {
  const result = plan(
    { services: { web: { volumes: ["..:/app/", "nm:/app/node_modules/"] } } },
    ["node_modules"]
  );
  expect(result.services.web).toBeUndefined();
  expect(result.kept).toEqual([
    { service: "web", entry: "node_modules", target: "/app/node_modules" },
  ]);
});

test("a bind source with a variable is not read as a checkout path", () => {
  const result = plan({ services: { web: { volumes: ["${PWD}/..:/app"] } } }, [
    "node_modules",
  ]);
  expect(result.unmatched).toEqual(["node_modules"]);
  expect(localDirectoriesNotices(result, ".hack/docker-compose.yml")).toEqual([
    "localDirectories: no service's source bind in .hack/docker-compose.yml shows node_modules; nothing kept local for it (mounts from variables, extends, include or other -f files are not read).",
  ]);
});

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function checkout(): Promise<{
  root: string;
  project: { projectRoot: string; projectDir: string; composeFile: string };
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-local-dirs-"));
  temps.push(root);
  await mkdir(join(root, ".hack"), { recursive: true });
  const composeFile = join(root, ".hack", "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n"
  );
  return {
    root,
    project: {
      projectRoot: root,
      projectDir: join(root, ".hack"),
      composeFile,
    },
  };
}

test("a missing entry is created in the checkout before Compose runs; a file entry is skipped", async () => {
  const { root, project } = await checkout();
  await writeFile(join(root, "package.json"), "{}");
  const notices: string[] = [];
  const files = await withLocalDirectoriesOverride({
    project,
    config: { localDirectories: ["apps/web/.next", "package.json"] },
    composeFiles: [project.composeFile],
    notify: (line) => notices.push(line),
  });
  expect(files).toHaveLength(2);
  expect((await stat(join(root, "apps/web/.next"))).isDirectory()).toBe(true);
  expect(notices).toEqual([
    "localDirectories: package.json is a file in the checkout, not a directory; skipped.",
  ]);
});

test("an entry under a symlink that leaves the checkout is not created", async () => {
  const { root, project } = await checkout();
  const outside = await mkdtemp(join(tmpdir(), "hack-local-dirs-outside-"));
  temps.push(outside);
  await symlink(outside, join(root, "apps"));
  await withLocalDirectoriesOverride({
    project,
    config: { localDirectories: ["apps/web/.next"] },
    composeFiles: [project.composeFile],
  });
  expect(await readdir(outside)).toEqual([]);
});

test("an invalid setting is refused by the override as a backstop", async () => {
  const { project } = await checkout();
  await expect(
    withLocalDirectoriesOverride({
      project,
      config: { localDirectoriesError: "bad" },
      composeFiles: [project.composeFile],
    })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
});

test("a directory that cannot be created is a notice, not a crash", async () => {
  const { root, project } = await checkout();
  await writeFile(join(root, "package.json"), "{}");
  const notices: string[] = [];
  const files = await withLocalDirectoriesOverride({
    project,
    config: { localDirectories: ["package.json/cache"] },
    composeFiles: [project.composeFile],
    notify: (line) => notices.push(line),
  });
  expect(files).toHaveLength(2);
  expect(notices).toEqual([
    "localDirectories: could not create package.json/cache in the checkout (ENOTDIR); the engine creates it instead.",
  ]);
});

test("a mount whose target uses a variable is never split or written into the override", () => {
  const result = plan(
    {
      services: {
        short: { volumes: ["..:${APP_DIR:-/app}"] },
        long: {
          volumes: [{ type: "bind", source: "..", target: "${APP_DIR}" }],
        },
        // A variable source with a plain target still marks the target taken.
        taken: { volumes: ["..:/app", "${DEPS}:/app/node_modules"] },
      },
    },
    ["node_modules"]
  );
  expect(result.services.short).toBeUndefined();
  expect(result.services.long).toBeUndefined();
  expect(result.services.taken).toBeUndefined();
  expect(result.kept).toEqual([
    { service: "taken", entry: "node_modules", target: "/app/node_modules" },
  ]);
  expect(JSON.stringify(localDirectoriesOverride(result))).not.toContain("$");
});

test("a service with a mount whose target is a variable gets nothing, with a notice", () => {
  const result = plan(
    {
      services: {
        // After interpolation this may be exactly /app/node_modules.
        web: { volumes: ["..:/app", "nm:${NM_DIR:-/app/node_modules}"] },
        api: {
          volumes: [
            "..:/srv",
            { type: "volume", source: "nm", target: "${NM_DIR}" },
          ],
        },
        plain: { volumes: ["..:/app"] },
      },
    },
    ["node_modules"]
  );
  expect(result.services.web).toBeUndefined();
  expect(result.services.api).toBeUndefined();
  expect(result.services.plain?.[0]?.target).toBe("/app/node_modules");
  expect(result.skipped).toEqual(["web", "api"]);
  expect(result.unmatched).toEqual([]);
  expect(localDirectoriesNotices(result)).toContain(
    "localDirectories: service web has a mount whose path comes from a variable; nothing kept local for it."
  );
});
