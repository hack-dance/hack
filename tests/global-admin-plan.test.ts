import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdminPlan,
  classifyDockerInfo,
  planGlobalInstallTrust,
  planGlobalTrust,
  type TrustPlanDeps,
} from "../src/commands/global-admin-plan.ts";
import {
  ensureMacTrustCaddyLocalCa,
  MAC_SUDO_PROBE_ARGV,
  type MacTrustCheck,
  type MacTrustDeps,
  macTrustAddArgv,
  prepareMacTrust,
} from "../src/commands/global-mac-trust.ts";
import {
  caddyCaExportReplaceable,
  repairCaddyCaExport,
} from "../src/lib/caddy-ca-export.ts";
import type { CaddyCaIdentity } from "../src/lib/caddy-ca-identity.ts";
import { validateCaddyRootPem } from "../src/lib/linux-trust.ts";
import {
  applyLinuxSystemTrust,
  type LinuxTrustHost,
  prepareLinuxSystemTrust,
} from "../src/lib/linux-trust-setup.ts";
import {
  runTrustedSudo,
  type SudoFs,
  trustedSudoInvocation,
} from "../src/lib/privileged-sudo.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

// R11 (HACK-2218): `hack global trust --plan --json` lists the root argv the
// real command runs. Each case runs the real decision and executor with a
// recording root boundary and compares what it would spawn with the plan.

const CERT = "<hack-home>/caddy/pki/caddy-local-authority.crt";
const SUDO = "/usr/bin/sudo";
const DEBIAN = "ID=ubuntu\nID_LIKE=debian\n";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

type Recorded = { readonly argv: readonly string[]; readonly input?: string };

/** A Linux trust host that answers reads and records root steps only. */
function linuxHost(opts: {
  readonly bundle: string;
  readonly recorded?: Recorded[];
  readonly tools?: boolean;
}): LinuxTrustHost {
  const refuse = (what: string) => async () => {
    throw new Error(`planning must not ${what}`);
  };
  return {
    homeDir: "<home>",
    configHome: "<home>/.config",
    dataHome: "<home>/.local/share",
    uid: 1000,
    readFile: async (path) =>
      await Promise.resolve(
        path === "/etc/os-release"
          ? DEBIAN
          : path === BUNDLE
            ? opts.bundle
            : null
      ),
    listDir: async () => await Promise.resolve([]),
    inspectPath: async () => await Promise.resolve(null),
    makeDir: refuse("create a directory"),
    resolveCommand: async (name) =>
      await Promise.resolve(
        opts.tools === false
          ? null
          : name === "update-ca-certificates"
            ? "/usr/sbin/update-ca-certificates"
            : null
      ),
    resolveSudo: async () => await Promise.resolve(SUDO),
    exec: refuse("run certutil"),
    runPrivileged: async (argv, input) => {
      if (!opts.recorded) {
        throw new Error("planning must not run a root step");
      }
      opts.recorded.push({ argv, ...(input === undefined ? {} : { input }) });
      return await Promise.resolve(0);
    },
  };
}

function trustDeps(overrides: Partial<TrustPlanDeps>): TrustPlanDeps {
  const current: CaddyCaIdentity = {
    state: "current",
    message: "current",
    currentPem: CURRENT_CA_PEM,
  };
  return {
    platform: "linux",
    refusal: () => null,
    certPath: CERT,
    inspectIdentity: async () => await Promise.resolve(current),
    readExport: async () => await Promise.resolve(CURRENT_CA_PEM),
    exportReplaceable: async () =>
      await Promise.resolve("replaceable" as const),
    linuxHost: linuxHost({ bundle: OLD_CA_PEM }),
    prepareLinux: prepareLinuxSystemTrust,
    dockerAnswers: async () => await Promise.resolve(false),
    readExportSource: async () => await Promise.resolve("none" as const),
    prepareMac: prepareMacTrust,
    explicitlyNonInteractive: () => false,
    ...overrides,
  };
}

const rootSteps = (plan: AdminPlan) =>
  plan.steps.filter((step) => step.privilege === "root");

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

test("macOS install cannot decide keychain trust from an old export when the runtime CA is not known", async () => {
  const standalone = trustDeps({
    platform: "darwin",
    dockerAnswers: () => Promise.resolve(false),
    readExportSource: () => Promise.resolve("none"),
    prepareMac: () => Promise.resolve({ status: "trusted" }),
  });
  expect((await planGlobalTrust(standalone)).complete).toBe(true);
  const install = await planGlobalInstallTrust(standalone);
  expect(install.complete).toBe(false);
  expect(rootSteps(install)).toEqual([]);
  expect(install.blocked[0]?.phase).toBe("keychain trust");
  for (const source of ["unknown", { pem: OLD_CA_PEM }] as const) {
    const unknown = await planGlobalInstallTrust({
      ...standalone,
      readExportSource: () => Promise.resolve(source),
    });
    expect(unknown.complete).toBe(false);
    expect(rootSteps(unknown)).toEqual([]);
  }
  const current = await planGlobalInstallTrust({
    ...standalone,
    readExportSource: () => Promise.resolve({ pem: CURRENT_CA_PEM }),
  });
  expect(current.complete).toBe(true);
});

test("Linux: the plan's root steps are exactly what the real trust step spawns", async () => {
  const plan = await planGlobalTrust(trustDeps({}));
  expect(plan).toMatchObject({ complete: true, refused: null });

  // The real system-trust step, confirmed, against the same host state.
  const validated = await validateCaddyRootPem({ pem: CURRENT_CA_PEM });
  if (!validated.ok) {
    throw new Error(validated.issue);
  }
  const recorded: Recorded[] = [];
  await applyLinuxSystemTrust({
    host: linuxHost({ bundle: OLD_CA_PEM, recorded }),
    ca: validated.ca,
    manualCertPath: CERT,
    canPrompt: true,
    show: () => undefined,
    confirm: async () => await Promise.resolve(true),
  });
  expect(recorded).toHaveLength(2);
  const planned = rootSteps(plan);
  expect(planned.map((step) => step.argv)).toEqual(
    recorded.map((step) =>
      trustedSudoInvocation({ sudo: SUDO, argv: step.argv })
    )
  );
  expect(planned.map((step) => step.stdin?.sha256 ?? null)).toEqual(
    recorded.map((step) =>
      step.input === undefined ? null : sha256(step.input)
    )
  );
  expect(planned[0]?.stdin?.bytes).toBe(Buffer.byteLength(CURRENT_CA_PEM));

  // And runTrustedSudo spawns that same argv, with those bytes on stdin.
  const spawned: { argv: readonly string[]; input: string | null }[] = [];
  const fs: SudoFs = {
    realpath: async (path) => await Promise.resolve(path),
    stat: async (path) =>
      await Promise.resolve({
        uid: 0,
        mode: path === SUDO ? 0o10_4755 : 0o04_0755,
        isFile: path === SUDO,
        isDirectory: path !== SUDO,
      }),
  };
  for (const step of recorded) {
    await runTrustedSudo(step.argv, {
      fs,
      ...(step.input === undefined
        ? {}
        : { input: new TextEncoder().encode(step.input) }),
      runner: async (argv) => {
        spawned.push({ argv, input: null });
        return await Promise.resolve(0);
      },
      inputRunner: async (argv, opts) => {
        spawned.push({ argv, input: new TextDecoder().decode(opts.input) });
        return await Promise.resolve(0);
      },
    });
  }
  expect(
    spawned.map((step) => step.argv as readonly string[] | undefined)
  ).toEqual(planned.map((step) => step.argv));
  expect(
    spawned.map((step) => (step.input === null ? null : sha256(step.input)))
  ).toEqual(planned.map((step) => step.stdin?.sha256 ?? null));
});

test("Linux: trusted already, manual, stale export and no runtime CA are planned as the run would act", async () => {
  const trusted = await planGlobalTrust(
    trustDeps({ linuxHost: linuxHost({ bundle: CURRENT_CA_PEM }) })
  );
  expect(rootSteps(trusted)).toEqual([]);
  expect(trusted.complete).toBe(true);

  const manual = await planGlobalTrust(
    trustDeps({ linuxHost: linuxHost({ bundle: OLD_CA_PEM, tools: false }) })
  );
  expect(rootSteps(manual)).toEqual([]);

  // A stale export: the run rewrites it from the runtime CA first, and
  // trusts those bytes.
  const stale = await planGlobalTrust(
    trustDeps({
      inspectIdentity: async () =>
        await Promise.resolve({
          state: "stale",
          message: "stale",
          currentPem: CURRENT_CA_PEM,
        }),
      readExport: async () => await Promise.resolve(OLD_CA_PEM),
    })
  );
  expect(stale.steps[0]).toMatchObject({
    privilege: "user",
    id: "refresh-ca-export",
  });
  expect(rootSteps(stale)[0]?.stdin?.sha256).toBe(sha256(CURRENT_CA_PEM));

  const none = await planGlobalTrust(
    trustDeps({
      inspectIdentity: async () =>
        await Promise.resolve({ state: "unavailable", message: "no Caddy" }),
    })
  );
  expect(none).toMatchObject({ complete: false, steps: [] });
  expect(none.blocked[0]?.prerequisite).toBe("hack global up");

  const refused = await planGlobalTrust(
    trustDeps({ refusal: () => "native runtime" })
  );
  expect(refused).toMatchObject({ refused: "native runtime", complete: false });
});

function macDeps(opts: {
  readonly trusted: boolean;
  readonly nonInteractive: boolean;
  readonly probeExit?: number;
  readonly recorded: { probe: string[][]; root: string[][] };
}): MacTrustDeps {
  return {
    confirm: async () => await Promise.resolve(true),
    checkTrust: async () =>
      await Promise.resolve({
        trusted: opts.trusted || opts.recorded.root.length > 0,
        installable: true,
      } satisfies MacTrustCheck),
    explicitlyNonInteractive: () => opts.nonInteractive,
    probe: async (argv) => {
      opts.recorded.probe.push([...argv]);
      return await Promise.resolve(opts.probeExit ?? 0);
    },
    runRoot: async (argv) => {
      opts.recorded.root.push([...argv]);
      return await Promise.resolve(0);
    },
  };
}

test("macOS: the plan lists the keychain step (and the sudo probe when non-interactive) exactly as run", async () => {
  for (const nonInteractive of [false, true]) {
    const check = async () =>
      await Promise.resolve({ trusted: false, installable: true });
    const plan = await planGlobalTrust(
      trustDeps({
        platform: "darwin",
        prepareMac: async (opts) =>
          await prepareMacTrust({ ...opts, checkTrust: check }),
        explicitlyNonInteractive: () => nonInteractive,
      })
    );
    const recorded = { probe: [] as string[][], root: [] as string[][] };
    await ensureMacTrustCaddyLocalCa(
      { certPath: CERT },
      macDeps({ trusted: false, nonInteractive, recorded })
    );
    expect(rootSteps(plan).map((step) => step.argv)).toEqual([
      ...recorded.probe,
      ...recorded.root,
    ]);
    expect(recorded.root).toEqual([[...macTrustAddArgv(CERT)]]);
    if (nonInteractive) {
      expect(rootSteps(plan)[0]).toMatchObject({
        argv: [...MAC_SUDO_PROBE_ARGV],
        gates: "keychain-trust",
      });
    }
  }
  // A failed probe stops before the keychain step: the run is the plan's
  // prefix up to the gate.
  const recorded = { probe: [] as string[][], root: [] as string[][] };
  await ensureMacTrustCaddyLocalCa(
    { certPath: CERT },
    macDeps({ trusted: false, nonInteractive: true, probeExit: 1, recorded })
  );
  expect(recorded).toEqual({ probe: [[...MAC_SUDO_PROBE_ARGV]], root: [] });

  // Already trusted: no root step in the plan or the run.
  const trusted = await planGlobalTrust(
    trustDeps({
      platform: "darwin",
      prepareMac: async (opts) =>
        await prepareMacTrust({
          ...opts,
          checkTrust: async () =>
            await Promise.resolve({ trusted: true, installable: true }),
        }),
    })
  );
  expect(rootSteps(trusted)).toEqual([]);
  const none = { probe: [] as string[][], root: [] as string[][] };
  await ensureMacTrustCaddyLocalCa(
    { certPath: CERT },
    macDeps({ trusted: true, nonInteractive: false, recorded: none })
  );
  expect(none).toEqual({ probe: [], root: [] });
});

test("macOS: the keychain phase is decided only for a CA known now; otherwise it is blocked, and an ineligible CA refuses", async () => {
  const untrusted = async (opts: { readonly certPath: string }) =>
    await prepareMacTrust({
      ...opts,
      checkTrust: async () =>
        await Promise.resolve({ trusted: false, installable: true }),
    });
  const mac = (overrides: Partial<TrustPlanDeps>) =>
    trustDeps({ platform: "darwin", prepareMac: untrusted, ...overrides });

  // Docker answers and the Compose-selected Caddy holds a different CA than
  // the export: the run trusts that one, so the phase is blocked (no root
  // argv), not decided from the old file.
  const differs = await planGlobalTrust(
    mac({
      dockerAnswers: async () => await Promise.resolve(true),
      readExportSource: async () => await Promise.resolve({ pem: OLD_CA_PEM }),
    })
  );
  expect(differs).toMatchObject({ complete: false, refused: null });
  expect(rootSteps(differs)).toEqual([]);
  expect(differs.steps[0]).toMatchObject({
    id: "export-ca",
    privilege: "user",
  });

  // The same CA: the export does not change it, and the phase is decided.
  const same = await planGlobalTrust(
    mac({
      dockerAnswers: async () => await Promise.resolve(true),
      readExportSource: async () =>
        await Promise.resolve({ pem: CURRENT_CA_PEM }),
    })
  );
  expect(same.complete).toBe(true);
  expect(rootSteps(same).map((step) => step.argv)).toEqual([
    [...macTrustAddArgv(CERT)],
  ]);

  // The Caddy's CA could not be read: blocked.
  const unreadable = await planGlobalTrust(
    mac({
      dockerAnswers: async () => await Promise.resolve(true),
      readExportSource: async () => await Promise.resolve("unknown" as const),
    })
  );
  expect(unreadable.complete).toBe(false);
  expect(rootSteps(unreadable)).toEqual([]);

  // Cold host: no export and Docker down. The run starts Docker and exports
  // first; the keychain phase is blocked.
  const cold = await planGlobalTrust(
    mac({ readExport: async () => await Promise.resolve(null) })
  );
  expect(cold.complete).toBe(false);
  expect(cold.steps[0]).toMatchObject({ id: "start-docker" });
  expect(rootSteps(cold)).toEqual([]);

  // Docker answers, no single Caddy container and no export: the run has
  // no CA and fails.
  const none = await planGlobalTrust(
    mac({
      dockerAnswers: async () => await Promise.resolve(true),
      readExport: async () => await Promise.resolve(null),
    })
  );
  expect(none.refused).not.toBeNull();

  // An ineligible CA (expired, malformed) is refused, as the run exits 1.
  const ineligible = await planGlobalTrust(
    mac({
      prepareMac: async (opts) =>
        await prepareMacTrust({
          ...opts,
          checkTrust: async () =>
            await Promise.resolve({
              trusted: false,
              installable: false,
              issue: "Current Caddy Local CA has expired at the current time",
            }),
        }),
    })
  );
  expect(ineligible).toMatchObject({
    refused: "Current Caddy Local CA has expired at the current time",
    complete: false,
    steps: [],
  });
});

test("macOS: a Docker probe that times out or cannot start leaves the phase unknown, never 'Docker is down'", async () => {
  // The production mapping of the bounded probe.
  expect(classifyDockerInfo({ exitCode: 0 })).toBe(true);
  expect(classifyDockerInfo({ exitCode: 1 })).toBe(false);
  for (const result of [{ exitCode: 124 }, { exitCode: 127 }, null]) {
    expect(classifyDockerInfo(result)).toBe("unknown");
  }
  // A slow Docker with a trusted export: the run may still copy a different
  // CA, so the plan is blocked and lists no root step, not complete.
  const plan = await planGlobalTrust(
    trustDeps({
      platform: "darwin",
      dockerAnswers: async () =>
        await Promise.resolve(classifyDockerInfo({ exitCode: 124 })),
      readExportSource: async () => {
        throw new Error("not reached");
      },
      prepareMac: async (opts) =>
        await prepareMacTrust({
          ...opts,
          checkTrust: async () =>
            await Promise.resolve({ trusted: true, installable: true }),
        }),
    })
  );
  expect(plan).toMatchObject({ complete: false, refused: null });
  expect(rootSteps(plan)).toEqual([]);
});

test("Linux: a stale export the refresh refuses to replace gives a refused plan, as the real refresh does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hack-admin-plan-export-"));
  try {
    const target = join(directory, "old.crt");
    await Bun.write(target, OLD_CA_PEM);
    const cases = {
      symlink: join(directory, "link.crt"),
      directory: join(directory, "dir.crt"),
      regular: join(directory, "regular.crt"),
      missing: join(directory, "missing.crt"),
    };
    await symlink(target, cases.symlink);
    await mkdir(cases.directory);
    await Bun.write(cases.regular, OLD_CA_PEM);
    const staleIdentity: CaddyCaIdentity = {
      state: "stale",
      message: "stale",
      currentPem: CURRENT_CA_PEM,
    };
    for (const [name, certPath] of Object.entries(cases)) {
      const planned = await planGlobalTrust(
        trustDeps({
          certPath,
          inspectIdentity: async () => await Promise.resolve(staleIdentity),
          readExport: async () => await Promise.resolve(OLD_CA_PEM),
          exportReplaceable: async () =>
            await caddyCaExportReplaceable(certPath),
        })
      );
      // The real refresh, confirmed, against the same path.
      const repaired = await repairCaddyCaExport({
        composeFile: join(directory, "compose.yml"),
        certPath,
        inspect: async () => await Promise.resolve(staleIdentity),
        confirm: async () => await Promise.resolve(true),
      });
      if (name === "symlink" || name === "directory") {
        expect(repaired.changed).toBe(false);
        expect(planned).toMatchObject({ complete: false, steps: [] });
        expect(planned.refused).toContain("not a regular file");
      } else {
        expect(repaired.changed).toBe(true);
        expect(planned).toMatchObject({ complete: true, refused: null });
        expect(planned.steps[0]).toMatchObject({ id: "refresh-ca-export" });
        expect(rootSteps(planned).length).toBeGreaterThan(0);
      }
    }
    expect(await Bun.file(target).text()).toBe(OLD_CA_PEM);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux: an unreadable export eligibility leaves the trust phase blocked", async () => {
  const planned = await planGlobalTrust(
    trustDeps({
      inspectIdentity: async () =>
        await Promise.resolve({
          state: "stale",
          message: "stale",
          currentPem: CURRENT_CA_PEM,
        }),
      exportReplaceable: async () => await Promise.resolve("unknown" as const),
    })
  );
  expect(planned).toMatchObject({ complete: false, refused: null, steps: [] });
  expect(planned.blocked[0]?.phase).toBe("system trust");
});
