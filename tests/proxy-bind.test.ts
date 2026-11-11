import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findProxyPortConflicts,
  type HostListener,
  PROXY_BIND_CONFIG_KEY,
  parseLsofListeners,
  parseProxyBindAddress,
  parseSsListeners,
  readProxyBindFromCompose,
  renderProxyPortConflictMessage,
} from "../src/lib/proxy-bind.ts";
import {
  diagnoseProxyPortConflict,
  listHostTcpListeners,
} from "../src/lib/proxy-port-listeners.ts";
import { renderGlobalCaddyCompose } from "../src/templates.ts";
import { restoreEnv } from "./helpers/env.ts";

describe("proxy bind address", () => {
  test("accepts IPv4 and IPv6 literals and rejects everything else", () => {
    expect(parseProxyBindAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(parseProxyBindAddress(" 0.0.0.0 ")).toBe("0.0.0.0");
    expect(parseProxyBindAddress("[::1]")).toBe("::1");
    expect(parseProxyBindAddress("FD00::1")).toBe("fd00::1");
    for (const bad of ["localhost", "127.0.0.1:443", "", "10.0.0", 443, null]) {
      expect(() => parseProxyBindAddress(bad)).toThrow(PROXY_BIND_CONFIG_KEY);
    }
  });

  test("default compose keeps publishing on every interface", () => {
    const text = renderGlobalCaddyCompose({});
    expect(text).toContain('      - "80:80"');
    expect(text).toContain('      - "443:443"');
    expect(readProxyBindFromCompose(text)).toBeNull();
  });

  test("a configured address is rendered and read back", () => {
    const v4 = renderGlobalCaddyCompose({ bindAddress: "127.0.0.1" });
    expect(v4).toContain('      - "127.0.0.1:80:80"');
    expect(v4).toContain('      - "127.0.0.1:443:443"');
    expect(v4).not.toContain('"443:443"\n');
    expect(readProxyBindFromCompose(v4)).toBe("127.0.0.1");

    const v6 = renderGlobalCaddyCompose({ bindAddress: "::1" });
    expect(v6).toContain('      - "[::1]:443:443"');
    expect(readProxyBindFromCompose(v6)).toBe("::1");
  });

  test("rendering is deterministic, so a reinstall does not revert the choice", () => {
    const opts = { useStaticCaddyIp: true, bindAddress: "127.0.0.1" } as const;
    expect(renderGlobalCaddyCompose(opts)).toBe(renderGlobalCaddyCompose(opts));
  });
});

describe("listener parsing", () => {
  test("ss -Hltnp", () => {
    const output = [
      'LISTEN 0      4096       10.8.0.2:443        0.0.0.0:*    users:(("vpn-client",pid=4242,fd=7))',
      "LISTEN 0      511        0.0.0.0:80         0.0.0.0:*",
      'LISTEN 0      4096          [::]:22            [::]:*    users:(("sshd",pid=1,fd=3))',
      "LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*",
      "LISTEN 0      4096   [fe80::1]%eth0:443        [::]:*",
    ].join("\n");
    expect(parseSsListeners(output)).toEqual([
      { address: "10.8.0.2", port: 443, process: "vpn-client", pid: 4242 },
      { address: "0.0.0.0", port: 80, process: null, pid: null },
      { address: "::", port: 22, process: "sshd", pid: 1 },
      { address: "127.0.0.53", port: 53, process: null, pid: null },
      { address: "fe80::1", port: 443, process: null, pid: null },
    ]);
  });

  test("lsof -nP -iTCP -sTCP:LISTEN", () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "vpnagent  321 root   12u  IPv4 0xabc      0t0  TCP 127.0.0.1:443 (LISTEN)",
      "com.docke 999 user   80u  IPv6 0xdef      0t0  TCP *:80 (LISTEN)",
    ].join("\n");
    expect(parseLsofListeners(output)).toEqual([
      { address: "127.0.0.1", port: 443, process: "vpnagent", pid: 321 },
      { address: "*", port: 80, process: "com.docke", pid: 999 },
    ]);
  });
});

describe("port conflicts", () => {
  const vpn: HostListener = {
    address: "10.8.0.2",
    port: 443,
    process: "vpn-client",
    pid: 4242,
  };
  const wildcard: HostListener = {
    address: "0.0.0.0",
    port: 80,
    process: null,
    pid: null,
  };
  const unrelated: HostListener = {
    address: "0.0.0.0",
    port: 8080,
    process: "dev",
    pid: 7,
  };

  test("Docker's default conflicts with any listener on the proxy ports", () => {
    expect(
      findProxyPortConflicts({
        listeners: [vpn, wildcard, unrelated],
        bindAddress: null,
      })
    ).toEqual([vpn, wildcard]);
  });

  test("a specific address conflicts only with itself and wildcards", () => {
    expect(
      findProxyPortConflicts({
        listeners: [vpn, unrelated],
        bindAddress: "127.0.0.1",
      })
    ).toEqual([]);
    expect(
      findProxyPortConflicts({
        listeners: [vpn, wildcard],
        bindAddress: "10.8.0.2",
      })
    ).toEqual([vpn, wildcard]);
  });

  test("the message names the listener and the setting", () => {
    const message = renderProxyPortConflictMessage({
      conflicts: [vpn, { ...wildcard, address: "::" }],
      bindAddress: null,
    });
    expect(message).toContain("- 10.8.0.2:443 vpn-client (pid 4242)");
    expect(message).toContain("- [::]:80 an unknown process");
    expect(message).toContain(
      `hack config set --global ${PROXY_BIND_CONFIG_KEY} 127.0.0.1`
    );
  });

  test("a missing ss/lsof (spawn failure) yields null, not a throw", async () => {
    const savedPath = process.env.PATH;
    const dir = await mkdtemp(join(tmpdir(), "hack-proxy-bind-path-"));
    process.env.PATH = dir;
    try {
      expect(await listHostTcpListeners()).toBeNull();
      expect(await diagnoseProxyPortConflict({ bindAddress: null })).toContain(
        PROXY_BIND_CONFIG_KEY
      );
    } finally {
      restoreEnv("PATH", savedPath);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("diagnosis uses the injected listener source", async () => {
    expect(
      await diagnoseProxyPortConflict({
        bindAddress: null,
        listListeners: async () => [vpn],
      })
    ).toContain("vpn-client");
    // Nothing visible (root-owned listener, no userland proxy): still name
    // the setting.
    for (const listListeners of [async () => [vpn], async () => null]) {
      const hint = await diagnoseProxyPortConflict({
        bindAddress: "127.0.0.1",
        listListeners,
      });
      expect(hint).toContain("could not start");
      expect(hint).toContain(PROXY_BIND_CONFIG_KEY);
    }
  });
});
