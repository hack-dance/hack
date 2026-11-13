import { expect, test } from "bun:test";
import { renderCompose } from "../src/init/compose.ts";
import { findComposeBackendFeatures } from "../src/lib/native-compose-backend-features.ts";
import {
  duplicateHackComposeNetworks,
  isHackExternalNetwork,
  isIgnoredHackComposeLabel,
} from "../src/lib/native-hack-compose-conventions.ts";

for (const name of ["hack-dev", "hack-logging"]) {
  test(`maps exact ${name} identity rather than trusting a logical alias`, () => {
    expect(isHackExternalNetwork(name, { external: true })).toBe(true);
    expect(isHackExternalNetwork("edge", { external: true, name })).toBe(true);
    expect(isHackExternalNetwork("edge", { external: { name } })).toBe(true);
    expect(
      isHackExternalNetwork(name, { external: true, name: "foreign" })
    ).toBe(false);
    expect(isHackExternalNetwork(name, { external: { name: "foreign" } })).toBe(
      false
    );
    expect(
      isHackExternalNetwork(name, { external: { name, other: "ignored" } })
    ).toBe(false);
    expect(
      isHackExternalNetwork(name, { external: { name }, name: "foreign" })
    ).toBe(false);
  });
}
test("only metadata is ignored; semantic Hack labels and routers stay reviewed", () => {
  for (const key of [
    "com.docker.compose.project",
    "io.hack-local.owner",
    "io.hack.native-config.owner",
    "hack.project",
    "hack.custom",
  ]) {
    expect(isIgnoredHackComposeLabel(key)).toBe(true);
  }
  for (const key of [
    "hack.dependencies.lockfiles",
    "hack.dependencies.unknown",
    "hack.service.one-shot",
    "hack.service.one-shot.extra",
    "caddy",
    "caddy.reverse_proxy",
    "traefik.enable",
  ]) {
    expect(isIgnoredHackComposeLabel(key)).toBe(false);
  }
});
test("the real init Compose renderer needs no network or metadata adaptation", () => {
  const document = Bun.YAML.parse(
    renderCompose({
      name: "native-conventions",
      services: [
        {
          name: "web",
          role: "http",
          image: "example/web:1",
          workingDir: "/app",
          command: "serve",
          env: new Map(),
          labels: new Map([
            ["caddy", "web.example.hack"],
            ["caddy.reverse_proxy", "{{upstreams 3000}}"],
            ["caddy.tls", "internal"],
          ]),
          networks: ["hack-dev", "default"],
          httpPort: 3000,
        },
      ],
    })
  );
  expect(findComposeBackendFeatures(document)).toEqual([]);
  expect(
    findComposeBackendFeatures({
      services: {
        web: {
          image: "example/web:1",
          labels: {
            "com.docker.compose.project": "old-project",
            "io.hack-local.owner": "forged",
          },
        },
      },
      networks: {
        "hack-dev": { external: true },
        "hack-logging": { external: true },
      },
    })
  ).toEqual([]);
  expect(
    findComposeBackendFeatures({
      networks: { "hack-dev": { external: true, name: "company-private" } },
    })
  ).toEqual(["external_network"]);
});

test("two aliases of one Hack network refuse instead of splitting connectivity", () => {
  for (const name of ["hack-dev", "hack-logging"]) {
    const document = {
      networks: {
        [name]: { external: true },
        alias: { external: { name } },
      },
    };
    expect(duplicateHackComposeNetworks(document)).toEqual([name]);
    expect(findComposeBackendFeatures(document)).toEqual([
      "duplicate_hack_network",
    ]);
  }
});
