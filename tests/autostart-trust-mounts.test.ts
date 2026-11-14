import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { YAML } from "bun";
import { composeRuntimeBackend } from "../src/backends/runtime-backend.ts";
import { renderInternalOverride } from "../src/commands/project.ts";
import { resolveAutostartTrustedTlsBinds } from "../src/lib/autostart-trust-mounts.ts";
import { isRecord } from "../src/lib/guards.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
let pki = "";
let ca = "";
let certificate = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-trust-mounts-"));
  pki = join(root, "caddy", "pki");
  ca = join(pki, "caddy-local-authority.crt");
  const publicRoot = rootCertificates[0];
  if (!publicRoot) {
    throw new Error("Runtime public CA fixture unavailable");
  }
  certificate = publicRoot;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function install() {
  await mkdir(pki, { recursive: true, mode: 0o700 });
  await writeFile(ca, certificate, { mode: 0o644 });
  await chmod(ca, 0o644);
}

test("only existing public CA inputs receive the exact generated read-only mount destinations", async () => {
  expect(await resolveAutostartTrustedTlsBinds({ hackHome: root })).toEqual([]);
  await install();
  const before = await lstat(ca);
  expect(await resolveAutostartTrustedTlsBinds({ hackHome: root })).toEqual([
    {
      source: ca,
      target: "/etc/hack/ca/caddy-local-authority.crt",
      readOnly: true,
    },
  ]);
  const bundle = join(pki, "caddy-host-trust-bundle.pem");
  await writeFile(bundle, `${certificate}\n${certificate}\n`, { mode: 0o644 });
  expect(await resolveAutostartTrustedTlsBinds({ hackHome: root })).toEqual([
    {
      source: ca,
      target: "/etc/hack/ca/caddy-local-authority.crt",
      readOnly: true,
    },
    { source: bundle, target: "/etc/hack/ca/trust-bundle.pem", readOnly: true },
  ]);
  expect((await lstat(ca)).ino).toBe(before.ino);
  expect((await lstat(ca)).mode).toBe(before.mode);
  expect(await readFile(ca, "utf8")).toBe(certificate);
});

test("writable or container-unreadable certificate inputs refuse without permission repair", async () => {
  await install();
  for (const mode of [0o666, 0o600]) {
    await chmod(ca, mode);
    await expect(
      resolveAutostartTrustedTlsBinds({ hackHome: root })
    ).rejects.toMatchObject({
      detail: { reason: "compose_inputs_require_manual_start" },
    });
    expect((await lstat(ca)).mode & 0o777).toBe(mode);
  }
});

test("symlinked inputs and unsafe parent directories are never admitted as generated trust mounts", async () => {
  await install();
  const target = join(root, "retained-ca");
  await writeFile(target, certificate, { mode: 0o644 });
  await rm(ca);
  await symlink(target, ca);
  await expect(
    resolveAutostartTrustedTlsBinds({ hackHome: root })
  ).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(await readFile(target, "utf8")).toBe(certificate);
  await rm(ca);
  await writeFile(ca, certificate, { mode: 0o644 });
  await chmod(pki, 0o777);
  await expect(
    resolveAutostartTrustedTlsBinds({ hackHome: root })
  ).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect((await lstat(pki)).mode & 0o777).toBe(0o777);
});

test("script bytes, appended non-certificate content and oversized inputs cannot use the TLS exception", async () => {
  await install();
  for (const text of [
    "#!/bin/sh\nexit 0\n",
    `${certificate}\nprintf unsafe\n`,
    "x".repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(ca, text);
    await expect(
      resolveAutostartTrustedTlsBinds({ hackHome: root })
    ).rejects.toMatchObject({ code: "E_PERMISSION" });
    expect((await lstat(ca)).size).toBe(Buffer.byteLength(text));
  }
});

test("the generated default TLS mount passes effective admission with authenticated certificates", async () => {
  await install();
  const generated: unknown = YAML.parse(
    renderInternalOverride({
      services: [{ name: "app", enableInternalDns: true }],
      dnsServer: null,
      extraHosts: {},
      caPath: ca,
      trustBundlePath: null,
    })
  );
  const services =
    isRecord(generated) && isRecord(generated.services)
      ? generated.services
      : undefined;
  const app = services?.app;
  const volumes: unknown = isRecord(app) ? app.volumes : undefined;
  if (
    !(
      Array.isArray(volumes) &&
      volumes.every((mount): mount is string => typeof mount === "string")
    )
  ) {
    throw new Error("Generated TLS mounts did not match the expected schema");
  }
  const mounts = volumes.map((mount) => {
    const [source, target, mode] = mount.split(":");
    return {
      type: "bind",
      source,
      target,
      read_only: mode === "ro",
      bind: { create_host_path: true },
    };
  });
  const model = {
    name: "example",
    services: { app: { image: "example/app:1", volumes: mounts } },
  };
  const bin = join(root, "bin");
  const phases = join(root, "phases");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("config")) { console.log(${JSON.stringify(JSON.stringify(model))});process.exit(0); }
if(args[0]==="image") { console.log("sha256:"+"a".repeat(64));process.exit(0); }
if(args.includes("up")) { const file=Bun.file(${JSON.stringify(phases)});await Bun.write(file,(await file.exists()?await file.text():"")+"phase\\n");process.exit(0); }
process.exit(97);
`,
    { mode: 0o700 }
  );
  let authentications = 0;
  expect(
    await composeRuntimeBackend.up({
      composeFiles: [join(root, "compose.yml")],
      cwd: root,
      env: privateCliEnv({ root, env: { PATH: bin } }),
      detach: true,
      unattended: true,
      unattendedTrustedBinds: () => {
        authentications += 1;
        return resolveAutostartTrustedTlsBinds({ hackHome: root });
      },
      imageTimeoutMs: 5000,
      startupTimeoutMs: 5000,
    })
  ).toBe(0);
  expect(authentications).toBeGreaterThanOrEqual(3);
  expect((await Bun.file(phases).text()).trim().split("\n")).toHaveLength(2);
});
