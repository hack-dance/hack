import { expect, test } from "bun:test";

import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_NETWORK,
} from "../src/constants.ts";
import {
  renderGlobalCaddyCompose,
  renderGlobalCoreDnsConfig,
} from "../src/templates.ts";

test("renderGlobalCoreDnsConfig uses template + fallthrough for static caddy ip", () => {
  const text = renderGlobalCoreDnsConfig({ useStaticCaddyIp: true });
  expect(text).toContain("template IN A");
  expect(text).toContain(`answer "{{ .Name }} 30 IN A ${DEFAULT_CADDY_IP}"`);
  expect(text).toContain("fallthrough");
  expect(text).toContain("forward . 127.0.0.11");
});

test("renderGlobalCoreDnsConfig uses rewrite for dynamic caddy ip", () => {
  const text = renderGlobalCoreDnsConfig();
  expect(text).toContain("rewrite name regex");
  expect(text).not.toContain("template IN A");
});

test("renderGlobalCaddyCompose pins caddy and coredns when requested", () => {
  const text = renderGlobalCaddyCompose({
    useStaticCaddyIp: true,
    useStaticCoreDnsIp: true,
  });
  expect(text).toContain("command:");
  expect(text).toContain("- docker-proxy");
  expect(text).toContain("- --polling-interval");
  expect(text).toContain("- 5s");
  expect(text).toContain(`name: ${DEFAULT_INGRESS_NETWORK}`);
  expect(text).toContain(`ipv4_address: ${DEFAULT_CADDY_IP}`);
  expect(text).toContain(`ipv4_address: ${DEFAULT_COREDNS_IP}`);
  expect(text).not.toContain("caddy_1:");
  expect(text).not.toContain("auth.hack");
  expect(text).toContain('"host.docker.internal:host-gateway"');
});

test("renderGlobalCoreDnsConfig matches .hack aliases and forwards external DNS", () => {
  const text = renderGlobalCoreDnsConfig({ useStaticCaddyIp: true });
  const matchLine = text.split("\n").find((line) => line.includes("match"));
  expect(matchLine).toContain("(.*)\\.hack(\\..*)?\\.?$");
  expect(text).toContain("forward . 127.0.0.11");

  const matcher = /(.*)\.hack(\..*)?\.?$/;
  expect(matcher.test("api.myapp.hack")).toBe(true);
  expect(matcher.test("core.sickemail.hack.gy")).toBe(true);
  expect(matcher.test("example.com")).toBe(false);
});

test("configured custom domain gets a narrow CoreDNS route without broad external capture", () => {
  const staticConfig = renderGlobalCoreDnsConfig({
    useStaticCaddyIp: true,
    defaultDomain: "project.example.test",
  });
  expect(staticConfig).toContain("(.*)\\.project\\.example\\.test\\.?)$");
  expect(staticConfig.match(/template IN A \{/g)).toHaveLength(1);
  expect(staticConfig.match(/template IN AAAA \{/g)).toHaveLength(1);
  const dynamicConfig = renderGlobalCoreDnsConfig({
    defaultDomain: "project.example.test",
  });
  expect(dynamicConfig).toContain(
    "(.*)\\.project\\.example\\.test\\.?)$ caddy"
  );
  expect(dynamicConfig).toContain("forward . 127.0.0.11");
});

test("routed names answer AAAA with empty NOERROR instead of falling through to the forwarder (HACK-2064)", () => {
  const text = renderGlobalCoreDnsConfig({ useStaticCaddyIp: true });
  const lines = text.split("\n");
  const start = lines.indexOf("  template IN AAAA {");
  expect(start).toBeGreaterThan(-1);
  const end = lines.indexOf("  }", start);
  const block = lines.slice(start, end + 1);
  const aBlockMatch = lines.find(
    (line, index) => index < start && line.trim().startsWith("match ")
  );
  // Same suffixes as the A record; no address and no IPv6 answer.
  expect(block).toContain(aBlockMatch ?? "<missing A match>");
  expect(block).toContain("    rcode NOERROR");
  expect(block.some((line) => line.includes("answer"))).toBe(false);
  // Unrelated AAAA queries still reach the forwarder.
  expect(block).toContain("    fallthrough");
  expect(lines.indexOf("  forward . 127.0.0.11")).toBeGreaterThan(end);

  const custom = renderGlobalCoreDnsConfig({
    useStaticCaddyIp: true,
    defaultDomain: "project.example.test",
  });
  const customLines = custom.split("\n");
  const customStart = customLines.indexOf("  template IN AAAA {");
  expect(customLines[customStart + 1]).toContain(
    "(.*)\\.project\\.example\\.test\\.?)$"
  );
});
