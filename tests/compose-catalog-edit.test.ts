import { expect, test } from "bun:test";
import { YAML } from "bun";
import { planCatalogEdit } from "../src/lib/compose-catalog-edit.ts";
import recipes from "../src/lib/service-catalog.json";

const file = ".hack/docker-compose.yml";

test("appends a service without changing neighboring YAML or line endings", () => {
  const source = [
    "# Top comment",
    "services:",
    "    # The web service",
    "    web: { image: 'example/web' } # inline comment",
    "# Keep the volume comment attached",
    "volumes: {}",
    "",
  ].join("\r\n");
  const addition =
    "    redis:\r\n      image: redis:7-alpine\r\n      volumes:\r\n        - redis-data:/data\r\n";
  const plan = planCatalogEdit({ text: source, file, id: "redis" });
  expect(plan.updated).toBe(
    source
      .replace("# Keep", `${addition}# Keep`)
      .replace("volumes: {}", "volumes: \r\n  redis-data: {}")
  );
  expect(plan.diff).toContain("@@ -4,0 +5,4 @@\n+    redis:");
  expect(plan.diff).not.toContain("example/web");
});

test("preserves empty-map comments and keeps managed credentials valueless", () => {
  const plan = planCatalogEdit({
    text: "services: {} # Add local dependencies here\n",
    file,
    id: "postgres",
    name: "db",
  });
  expect(plan.updated).toContain("# Add local dependencies here\n");
  expect(YAML.parse(plan.updated)).toEqual({
    services: {
      db: {
        image: "postgres:17-alpine",
        environment: { POSTGRES_PASSWORD: null },
        volumes: ["db-data:/var/lib/postgresql/data"],
      },
    },
    volumes: { "db-data": {} },
  });
  expect(plan.credentials).toEqual(["POSTGRES_PASSWORD"]);
});

test("detects collisions and refuses ambiguous Compose inputs", () => {
  const plan = (text: string) => planCatalogEdit({ text, file, id: "redis" });
  expect(() => plan("services:\n  'redis': { image: redis }\n")).toThrow(
    "already exists"
  );
  expect(() => plan("include: [shared.yaml]\nservices: {}\n")).toThrow(
    "without includes"
  );
  expect(() => plan("services: [redis]\n")).toThrow("block-style");
});

test("adds a missing services section before an explicit document end", () => {
  const plan = planCatalogEdit({
    text: "name: example\n...\n# footer\n",
    file,
    id: "redis",
  });
  expect(plan.updated).toBe(
    "name: example\nservices:\n  redis:\n    image: redis:7-alpine\n    volumes:\n      - redis-data:/data\nvolumes:\n  redis-data: {}\n...\n# footer\n"
  );
});

// Linux arm64/amd64 OCI image config Config.Volumes from Docker Hub for these
// catalog tags, checked 2026-11-24. MinIO comes from the upstream Dockerfile
// at RELEASE.2025-09-07T16-13-09Z (its public registry config was unavailable).
const IMAGE_VOLUMES: Record<string, readonly string[]> = {
  "redis:7-alpine": ["/data"],
  "postgres:17-alpine": ["/var/lib/postgresql/data"],
  "mysql:8.4": ["/var/lib/mysql"],
  "mongo:8": ["/data/configdb", "/data/db"],
  "minio/minio": ["/data"],
  "axllent/mailpit": [],
};

test.each(
  recipes
)("$image covers its declared volume paths with named volumes", (recipe) => {
  const plan = planCatalogEdit({
    text: "services: {}\n",
    file,
    id: recipe.name,
  });
  const config = YAML.parse(plan.updated) as {
    services: Record<string, { volumes?: string[] }>;
    volumes?: Record<string, object>;
  };
  const mounts = config.services[recipe.name]?.volumes ?? [];
  const expected = IMAGE_VOLUMES[recipe.image];
  if (!expected) {
    throw new Error(`Missing image-volume inventory for ${recipe.image}`);
  }
  expect(Object.values(recipe.volumes).sort()).toEqual([...expected]);
  expect(mounts.map((mount) => mount.split(":")[1]).sort()).toEqual([
    ...expected,
  ]);
  expect(mounts.map((mount) => mount.split(":")[0]).sort()).toEqual(
    Object.keys(config.volumes ?? {}).sort()
  );
});

test("keeps existing volume definitions and unrelated lines out of the diff", () => {
  const text =
    "volumes:\n  existing: {} # retain\n# Unchanged fixture note\nnetworks: {}\nservices:\n  web: { image: example/web }\n";
  const plan = planCatalogEdit({ text, file, id: "mongodb" });
  expect(plan.updated).toContain("  existing: {} # retain\n  mongodb-");
  expect(plan.diff).not.toContain("Unchanged fixture note");
  expect(plan.diff).not.toContain("example/web");
  expect(() =>
    planCatalogEdit({
      text: text.replace("existing", "mongodb-db"),
      file,
      id: "mongodb",
    })
  ).toThrow("volume name already exists");
});
