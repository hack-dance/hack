import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { assertAutostartCheckoutTrusted } from "../src/lib/autostart-checkout-trust.ts";
import { assertAutostartDockerConfigTrusted } from "../src/lib/autostart-docker-trust.ts";
import * as acl from "../src/lib/autostart-path-acl.ts";
import { withAutostartProjectLock } from "../src/lib/autostart-project-lock.ts";
import { secureAutostartRoutingAssets } from "../src/lib/autostart-routing-assets.ts";
import { autostartStartPolicyRefusal } from "../src/lib/autostart-start-policy.ts";
import { resolveAutostartTrustedTlsBinds } from "../src/lib/autostart-trust-mounts.ts";
import { readProjectsRegistry } from "../src/lib/projects-registry.ts";

let root = "";
let projectDir = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-acl-boundary-"));
  projectDir = join(root, ".hack");
  await mkdir(projectDir, { mode: 0o700 });
  await writeFile(join(projectDir, "hack.config.json"), '{"name":"fixture"}', {
    mode: 0o600,
  });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  app:\n    image: example.invalid/app\n",
    { mode: 0o600 }
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("sync ACL checks use bounded batches, permit read-only inheritance and refuse unknown mutation", () => {
  const paths = new Set(
    Array.from({ length: 129 }, (_, i) => `/fixture/path-${i}`)
  );
  const batches: number[] = [];
  acl.assertAutostartPathAclsTrustedSync(paths, {
    platform: "darwin",
    inspectSync: (entries, timeoutMs) => {
      batches.push(entries.length);
      expect(timeoutMs).toBeLessThanOrEqual(3000);
      return {
        exitCode: 0,
        stdout:
          " 0: group:readers allow read,readattr,file_inherit,directory_inherit,inherited\n",
      };
    },
  });
  expect(batches).toEqual([128, 1]);
  for (const result of [
    { exitCode: 0, stdout: " 0: user:other allow write\n" },
    { exitCode: 124, stdout: "" },
  ]) {
    expect(() =>
      acl.assertAutostartPathAclsTrustedSync(paths, {
        platform: "darwin",
        inspectSync: () => result,
      })
    ).toThrow();
  }
  expect(() =>
    acl.assertAutostartPathAclsTrustedSync(
      new Set(Array.from({ length: 16_385 }, (_, i) => `/fixture/${i}`)),
      {
        platform: "darwin",
        inspectSync: () => {
          throw new Error("Oversized inventory must not run a probe");
        },
      }
    )
  ).toThrow("exceeds bound");
});

test("descriptor ACL inventory includes the file and full parent chain", async () => {
  const path = join(projectDir, "hack.config.json");
  await acl.assertAutostartFileAclsTrusted(
    { path, uid: process.getuid?.() ?? -1 },
    {
      platform: "darwin",
      inspect: async (paths) => {
        expect(paths).toContain("/");
        expect(paths).toContain(root);
        expect(paths).toContain(projectDir);
        expect(paths).toContain(path);
        return { exitCode: 0, stdout: "" };
      },
    }
  );
});

test("checkout and Docker plugin trust refuse ACL mutation on their complete inventories", async () => {
  const pluginDir = join(root, ".docker", "cli-plugins");
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  const plugin = join(pluginDir, "docker-compose");
  await writeFile(plugin, "synthetic plugin", { mode: 0o700 });
  const inventories: Set<string>[] = [];
  const audit = spyOn(
    acl,
    "assertAutostartPathAclsTrustedSync"
  ).mockImplementation((paths) => {
    inventories.push(new Set(paths));
    throw new Error("Synthetic mutation ACL");
  });
  try {
    expect(() =>
      assertAutostartCheckoutTrusted({ repoRoot: root, projectDir })
    ).toThrow("Autostart cannot trust");
    expect(() =>
      assertAutostartDockerConfigTrusted({
        home: root,
        systemPluginDirectories: [],
      })
    ).toThrow();
    expect(inventories[0]?.has(join(projectDir, "hack.config.json"))).toBe(
      true
    );
    expect(inventories[1]?.has(plugin)).toBe(true);
    expect(
      inventories.every((paths) => paths.has("/") && paths.has(root))
    ).toBe(true);
  } finally {
    audit.mockRestore();
  }
});

test("policy, TLS and routing ACL refusals happen before effects", async () => {
  const pki = join(root, "caddy", "pki");
  await mkdir(pki, { recursive: true, mode: 0o700 });
  await writeFile(
    join(pki, "caddy-local-authority.crt"),
    rootCertificates[0] ?? "",
    { mode: 0o644 }
  );
  const audit = spyOn(acl, "assertAutostartPathAclsTrusted").mockImplementation(
    async () => {
      throw new Error("Synthetic mutation ACL");
    }
  );
  try {
    expect(
      await autostartStartPolicyRefusal({
        repoRoot: root,
        projectDir,
        projectDirName: ".hack",
        globalConfigPath: join(root, "global.json"),
      })
    ).toBe("compose_inputs_require_manual_start");
    await expect(
      resolveAutostartTrustedTlsBinds({ hackHome: root })
    ).rejects.toMatchObject({ code: "E_PERMISSION" });
    await expect(
      secureAutostartRoutingAssets({
        root,
        bindAddress: null,
        defaultDomain: "hack",
      })
    ).rejects.toMatchObject({ code: "E_PERMISSION" });
    expect(audit).toHaveBeenCalledTimes(3);
  } finally {
    audit.mockRestore();
  }
});

test("registry reads and startup locks fail closed on descriptor ACL refusal", async () => {
  const registryPath = join(projectDir, "projects.json");
  await writeFile(registryPath, '{"version":1,"projects":[]}', { mode: 0o600 });
  const audit = spyOn(acl, "assertAutostartFileAclsTrusted").mockImplementation(
    async () => {
      throw new Error("Synthetic mutation ACL");
    }
  );
  try {
    await expect(
      readProjectsRegistry({ registryPath, requireAutostartTrust: true })
    ).rejects.toThrow();
    await expect(
      withAutostartProjectLock({
        registryPath,
        scope: {
          projectId: "fixture",
          composeProject: "fixture",
          branch: null,
        },
        run: () => {
          throw new Error("Unsafe lock body must not run");
        },
      })
    ).rejects.toMatchObject({ code: "E_PERMISSION" });
    expect(audit).toHaveBeenCalledTimes(2);
  } finally {
    audit.mockRestore();
  }
});
