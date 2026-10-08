import { expect, test } from "bun:test";
import { proxyHasNoPublishedPorts } from "./e2e/scenarios/native-config-routing.ts";

test("unpublished exposed and stopped ports are safe for the isolated proxy", () => {
  for (const runtimePorts of [null, {}, { "80/tcp": null, "443/tcp": null }]) {
    expect(
      proxyHasNoPublishedPorts({ publishAll: false, ports: {}, runtimePorts })
    ).toBe(true);
  }
});

test("dynamic publication refuses even when explicit bindings are empty", () => {
  expect(
    proxyHasNoPublishedPorts({
      publishAll: true,
      ports: {},
      runtimePorts: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }] },
    })
  ).toBe(false);
  expect(
    proxyHasNoPublishedPorts({
      publishAll: false,
      ports: {},
      runtimePorts: { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "19443" }] },
    })
  ).toBe(false);
});

test("missing, malformed and explicit published port facts refuse", () => {
  for (const facts of [
    {},
    { publishAll: false, ports: [], runtimePorts: {} },
    { publishAll: "false", ports: {}, runtimePorts: {} },
    { publishAll: false, ports: {}, runtimePorts: [] },
    { publishAll: false, ports: {}, runtimePorts: { "80/tcp": [] } },
    { publishAll: false, ports: { "80/tcp": [] }, runtimePorts: {} },
  ]) {
    expect(proxyHasNoPublishedPorts(facts)).toBe(false);
  }
});
