import { expect, test } from "bun:test";
import { YAML } from "bun";
import { planCatalogEdit } from "../src/lib/compose-catalog-edit.ts";

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
  const addition = "    redis:\r\n      image: redis:7-alpine\r\n";
  const plan = planCatalogEdit({ text: source, file, id: "redis" });
  expect(plan.updated).toBe(source.replace("# Keep", `${addition}# Keep`));
  expect(plan.diff).toContain("@@ -4,0 +5,2 @@\n+    redis:");
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
      },
    },
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
    "name: example\nservices:\n  redis:\n    image: redis:7-alpine\n...\n# footer\n"
  );
});
