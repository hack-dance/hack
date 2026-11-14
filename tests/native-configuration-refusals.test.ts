import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { readNativeConfigurationRefusals } from "../src/backends/native-configuration-refusals.ts";

const detail = {
  text_fixed: true,
  service: "api.worker",
  field: "healthcheck.x-hack-http",
  message: "The route needs a native HTTP probe.",
  fix: "Declare the probe on the route port.",
};

test("the runtime configuration field and literal text vocabulary fits the decoder", async () => {
  const paths = [
    "provider/graph/config.rs",
    "provider/graph/routes.rs",
    "project/compose/dependency_cache.rs",
    "project/compose/service.rs",
  ];
  let count = 0;
  for (const path of paths) {
    const source =
      (await readFile(`packages/runtime-core/src/${path}`, "utf8")).split(
        "#[cfg(test)]"
      )[0] ?? "";
    // All producers use these literal-only constructors, including closures
    // and detail()'s closed key-to-field match. Ignore test fixture literals.
    const calls =
      /(?:ConfigurationRefusal::new|refuse|detail)\(\s*("(?:[^"\\]|\\.)*"|[A-Z_]+|key|field)\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")/g;
    for (const match of source.matchAll(calls)) {
      const token = match[1] ?? "";
      const field = token.startsWith('"')
        ? (JSON.parse(token) as string)
        : "labels";
      const value = {
        ...detail,
        field: field || "labels",
        message: JSON.parse(match[2] ?? "null") as unknown,
        fix: JSON.parse(match[3] ?? "null") as unknown,
      };
      expect(
        readNativeConfigurationRefusals([value]),
        `${path}: ${field}`
      ).toBeDefined();
      count++;
    }
    for (const match of source.matchAll(/=>\s*"(labels(?:\.[a-z.-]+)?)"/g)) {
      expect(
        readNativeConfigurationRefusals([{ ...detail, field: match[1] }]),
        path
      ).toBeDefined();
    }
  }
  expect(count).toBeGreaterThanOrEqual(20);
});

test("configuration details accept only literal-marked, bounded field and service locations", () => {
  expect(
    readNativeConfigurationRefusals([{ ...detail, raw: "private-sentinel" }])
  ).toEqual([
    {
      service: detail.service,
      field: detail.field,
      message: detail.message,
      fix: detail.fix,
    },
  ]);
  for (const bad of [
    null,
    {},
    { ...detail, text_fixed: false },
    { ...detail, service: "../private-sentinel" },
    { ...detail, field: "labels.private-sentinel" },
    { ...detail, message: "private-sentinel\n" },
    { ...detail, fix: "x".repeat(401) },
    { ...detail, service: "s".repeat(129) },
  ]) {
    expect(readNativeConfigurationRefusals([detail, bad])).toBeUndefined();
  }
  expect(
    readNativeConfigurationRefusals(Array.from({ length: 4097 }, () => detail))
  ).toBeUndefined();
});
