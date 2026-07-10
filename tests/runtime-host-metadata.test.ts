import { expect, test } from "bun:test";
import { YAML } from "bun";

import { isRecord } from "../src/lib/guards.ts";
import {
  buildRuntimeHostMetadataOverride,
  type RuntimeHostMetadata,
} from "../src/lib/runtime-host-metadata.ts";

const BASE_COMPOSE = [
  "services:",
  "  web:",
  "    image: app",
  "    environment:",
  '      HACK_SERVICE_URL: "user-owned"',
  "    labels:",
  '      caddy: "demo.hack, demo.hack.gy"',
  "  api:",
  "    image: app",
  "  worker:",
  "    image: app",
  "",
].join("\n");

const ROUTING_OVERRIDE = [
  "services:",
  "  api:",
  "    labels:",
  '      - "caddy=api.demo.hack, api.demo.hack.gy"',
  "",
].join("\n");

test("runtime metadata exposes the effective public service map to every service", () => {
  const override = buildRuntimeHostMetadataOverride({
    composeYamls: [BASE_COMPOSE, ROUTING_OVERRIDE],
    branch: null,
    devHost: "demo.hack",
    aliasHost: "demo.hack.gy",
    composeProject: "demo",
  });
  expect(override).not.toBeNull();

  const web = readServiceEnvironment({ override, service: "web" });
  const worker = readServiceEnvironment({ override, service: "worker" });
  const metadata = readRuntimeMetadata({ environment: worker });

  expect(metadata).toEqual({
    version: 1,
    branch: null,
    composeProject: "demo",
    hosts: { dev: "demo.hack", alias: "demo.hack.gy" },
    services: {
      web: { urls: ["https://demo.hack", "https://demo.hack.gy"] },
      api: {
        urls: ["https://api.demo.hack", "https://api.demo.hack.gy"],
      },
    },
  });
  expect(web.HACK_DEV_URL).toBe("https://demo.hack");
  expect(web.HACK_ALIAS_URL).toBe("https://demo.hack.gy");
  expect(web.HACK_SERVICE_NAME).toBe("web");
  expect(web.HACK_SERVICE_URL).toBeUndefined();
  expect(JSON.parse(web.HACK_SERVICE_URLS ?? "null")).toEqual([
    "https://demo.hack",
    "https://demo.hack.gy",
  ]);
  expect(worker.HACK_SERVICE_URL).toBeUndefined();
  expect(worker.HACK_SERVICE_URLS).toBe("[]");
});

test("runtime metadata rewrites every public URL for a branch instance", () => {
  const override = buildRuntimeHostMetadataOverride({
    composeYamls: [BASE_COMPOSE, ROUTING_OVERRIDE],
    branch: "feature-x",
    devHost: "demo.hack",
    aliasHost: "demo.hack.gy",
    composeProject: "demo--feature-x",
  });
  const api = readServiceEnvironment({ override, service: "api" });
  const metadata = readRuntimeMetadata({ environment: api });

  expect(api).toMatchObject({
    HACK_BRANCH: "feature-x",
    HACK_COMPOSE_PROJECT: "demo--feature-x",
    HACK_DEV_HOST: "feature-x.demo.hack",
    HACK_DEV_URL: "https://feature-x.demo.hack",
    HACK_ALIAS_HOST: "feature-x.demo.hack.gy",
    HACK_ALIAS_URL: "https://feature-x.demo.hack.gy",
    HACK_SERVICE_NAME: "api",
    HACK_SERVICE_URL: "https://api.feature-x.demo.hack",
  });
  expect(metadata.services.api?.urls).toEqual([
    "https://api.feature-x.demo.hack",
    "https://api.feature-x.demo.hack.gy",
  ]);
  expect(metadata.services.web?.urls).toEqual([
    "https://feature-x.demo.hack",
    "https://feature-x.demo.hack.gy",
  ]);
});

function readServiceEnvironment(opts: {
  readonly override: string | null;
  readonly service: string;
}): Record<string, string> {
  if (!opts.override) {
    throw new Error("Expected a runtime metadata override");
  }
  const parsed: unknown = YAML.parse(opts.override);
  if (!(isRecord(parsed) && isRecord(parsed.services))) {
    throw new Error("Runtime metadata override has no services");
  }
  const service = parsed.services[opts.service];
  if (!(isRecord(service) && isRecord(service.environment))) {
    throw new Error(`Runtime metadata override has no ${opts.service} env`);
  }
  return Object.fromEntries(
    Object.entries(service.environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function readRuntimeMetadata(opts: {
  readonly environment: Readonly<Record<string, string>>;
}): RuntimeHostMetadata {
  const raw = opts.environment.HACK_RUNTIME_METADATA;
  if (!raw) {
    throw new Error("Missing HACK_RUNTIME_METADATA");
  }
  return JSON.parse(raw) as RuntimeHostMetadata;
}
