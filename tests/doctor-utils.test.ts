import { expect, test } from "bun:test";

import {
  analyzeComposeNetworkHygiene,
  dnsmasqConfigHasDomain,
  resolverHasNameserver,
} from "../src/commands/doctor-utils.ts";

const baseCompose = `
services:
  api:
    image: node:20
    labels:
      caddy: api.myapp.hack
    networks:
      - hack-dev
  db:
    image: postgres:17
    networks:
      - hack-dev
  redis:
    image: redis:7
    networks:
      - hack-dev
`;

test("analyzeComposeNetworkHygiene flags internal services without caddy labels", () => {
  const result = analyzeComposeNetworkHygiene({ yamlText: baseCompose });
  if ("error" in result) {
    throw new Error("expected offenders");
  }
  expect(result.offenders).toEqual(["db", "redis"]);
});

test("analyzeComposeNetworkHygiene accepts caddy labels in array form", () => {
  const yamlText = `
services:
  db:
    image: postgres:17
    labels:
      - "caddy=db.myapp.hack"
    networks:
      - hack-dev
`;
  const result = analyzeComposeNetworkHygiene({ yamlText });
  if ("error" in result) {
    throw new Error("expected offenders");
  }
  expect(result.offenders).toEqual([]);
});

test("analyzeComposeNetworkHygiene reports invalid yaml", () => {
  const result = analyzeComposeNetworkHygiene({ yamlText: "services: [" });
  expect(result).toEqual({ error: "invalid-yaml" });
});

test("analyzeComposeNetworkHygiene reports missing services", () => {
  const result = analyzeComposeNetworkHygiene({ yamlText: "version: '3.9'" });
  expect(result).toEqual({ error: "missing-services" });
});

test("resolverHasNameserver matches exact resolver lines", () => {
  const text = "# comment\nnameserver 127.0.0.1\nport 53\n";
  expect(resolverHasNameserver({ text, nameserver: "127.0.0.1" })).toBe(true);
  expect(resolverHasNameserver({ text, nameserver: "127.0.0.2" })).toBe(false);
});

test("dnsmasqConfigHasDomain detects expected address line", () => {
  const text = "address=/.hack/127.0.0.1\naddress=/.hack.gy/127.0.0.1\n";
  expect(dnsmasqConfigHasDomain({ text, domain: "hack" })).toBe(true);
  expect(dnsmasqConfigHasDomain({ text, domain: "example" })).toBe(false);
});
