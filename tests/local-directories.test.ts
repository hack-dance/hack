import { expect, test } from "bun:test";
import {
  localDirectoriesNotices,
  localDirectoriesOverride,
  localDirectoryVolumeName,
  parseLocalDirectories,
  planLocalDirectories,
} from "../src/lib/local-directories.ts";
import { parseProjectConfigRecord } from "../src/lib/project.ts";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";

const ROOT = "/work/app";
const COMPOSE_DIR = "/work/app/.hack";

const VALID = [
  "node_modules",
  "apps/web/.next",
  "dist/",
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
];

test("parseLocalDirectories accepts relative checkout paths and normalizes a trailing slash", () => {
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
  expect(parseLocalDirectories(["a", "a/"])).toHaveProperty("error");
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
    "localDirectories: node_modules is not under any service's source mount; nothing to keep local.",
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
