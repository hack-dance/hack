import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivate } from "../src/lib/native-compose-private-state.ts";
import {
  proxyHasNoPublishedPorts,
  runNativeRoutingFixtureTlsAttempt,
} from "./e2e/scenarios/native-routing-fixture-ingress.ts";

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

test("a failed exact TLS attempt retains bounded private stderr and its exit disposition", async () => {
  const root = await mkdtemp(join(tmpdir(), "routing-tls-capture-"));
  let settled = false;
  try {
    const executable = join(root, "docker");
    const id = "a".repeat(64);
    const expected = [
      "exec",
      id,
      "curl",
      "--disable",
      "--silent",
      "--show-error",
      "--fail",
      "--proxy",
      "",
      "--noproxy",
      "*",
      "--proto",
      "=https",
      "--max-redirs",
      "0",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--cacert",
      "/data/caddy/pki/authorities/local/root.crt",
      "--resolve",
      "retained-origin.test:443:127.0.0.1",
      "--url",
      "https://retained-origin.test/",
    ];
    await writeFile(
      executable,
      `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(expected))})process.exit(97);console.error("fixed synthetic TLS alert");process.exit(35);\n`,
      { flag: "wx", mode: 0o700 }
    );
    await chmod(executable, 0o700);
    const captures = join(root, "captures");
    const result = await runNativeRoutingFixtureTlsAttempt({
      docker: executable,
      proxyId: id,
      origin: "https://retained-origin.test",
      cwd: root,
      captures,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 2000,
    });
    settled = true;
    expect(result.exitCode).toBe(35);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("fixed synthetic TLS alert\n");
    const leaves = await readdir(captures);
    expect(leaves.length).toBe(3);
    for (const leaf of leaves) {
      expect((await lstat(join(captures, leaf))).mode & 0o777).toBe(0o600);
    }
    const receipt = await readPrivate(join(captures, "attempt.json"), 1024);
    expect(JSON.parse(receipt.text)).toEqual({
      exitCode: 35,
      timedOut: false,
      stdoutBytes: 0,
      stderrBytes: 26,
    });
    const stderr = leaves.find((leaf) => leaf.endsWith(".stderr"));
    expect(stderr).toBeDefined();
    if (!stderr) {
      throw new Error("Missing private TLS stderr capture");
    }
    expect((await readPrivate(join(captures, stderr), 1024)).text).toBe(
      "fixed synthetic TLS alert\n"
    );
  } finally {
    if (settled) {
      await rm(root, { recursive: true, force: true });
    }
  }
});
