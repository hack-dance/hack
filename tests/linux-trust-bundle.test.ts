import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeLinuxHostTrustBundle } from "../src/commands/global.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function setup(): Promise<{
  readonly dir: string;
  readonly certPath: string;
  readonly bundlePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "hack-linux-trust-"));
  tempDirs.add(dir);
  const certPath = join(dir, "caddy-local-authority.crt");
  await writeFile(
    certPath,
    "-----BEGIN CERTIFICATE-----\nLOCALCA\n-----END CERTIFICATE-----\n"
  );
  return { dir, certPath, bundlePath: join(dir, "bundle.pem") };
}

test("concatenates the first available system bundle with the local CA", async () => {
  const { dir, certPath, bundlePath } = await setup();
  const missing = join(dir, "missing.crt");
  const system = join(dir, "ca-certificates.crt");
  await writeFile(
    system,
    "-----BEGIN CERTIFICATE-----\nPUBLICROOT\n-----END CERTIFICATE-----\n"
  );

  const result = await writeLinuxHostTrustBundle({
    certPath,
    systemBundleCandidates: [missing, system],
    bundlePath,
  });

  expect(result).toBe(bundlePath);
  const text = await Bun.file(bundlePath).text();
  expect(text).toContain("PUBLICROOT");
  expect(text).toContain("LOCALCA");
  expect(text.indexOf("PUBLICROOT")).toBeLessThan(text.indexOf("LOCALCA"));
});

test("returns null (append-only fallback) when no system bundle exists", async () => {
  const { dir, certPath, bundlePath } = await setup();

  const result = await writeLinuxHostTrustBundle({
    certPath,
    systemBundleCandidates: [join(dir, "nope-a"), join(dir, "nope-b")],
    bundlePath,
  });

  expect(result).toBeNull();
  expect(await Bun.file(bundlePath).exists()).toBe(false);
});

test("returns null when the local CA is unreadable", async () => {
  const { dir, bundlePath } = await setup();
  const system = join(dir, "ca-certificates.crt");
  await writeFile(
    system,
    "-----BEGIN CERTIFICATE-----\nPUBLICROOT\n-----END CERTIFICATE-----\n"
  );

  const result = await writeLinuxHostTrustBundle({
    certPath: join(dir, "missing-ca.crt"),
    systemBundleCandidates: [system],
    bundlePath,
  });

  expect(result).toBeNull();
});
