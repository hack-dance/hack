import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type AdminPlan,
  type InstallPlanDeps,
  type MacInstallSnapshot,
  planGlobalInstall,
} from "../src/commands/global-admin-plan.ts";
import { executeMacPrivilegedCommand } from "../src/commands/global-install-actions.ts";
import {
  applyLinuxDns,
  type LinuxDnsHost,
} from "../src/lib/linux-dns-setup.ts";
import { runTrustedSudo, type SudoFs } from "../src/lib/privileged-sudo.ts";

const DOMAINS = ["hack", "hack.local", "hack.gy"];
const SUDO = "/usr/bin/sudo";
const BREW = "/opt/Example Tools/bin/brew";
const HELPER = "/Library/Example/helper";

type Recorded = {
  readonly argv: readonly string[];
  readonly input?: Uint8Array;
};

const sudoFs: SudoFs = {
  realpath: (path) => Promise.resolve(path),
  stat: (path) =>
    Promise.resolve({
      uid: 0,
      mode: path === SUDO ? 0o10_4755 : 0o04_0755,
      isFile: path === SUDO,
      isDirectory: path !== SUDO,
    }),
};

/** No real filesystem, resolver, Docker or root runner is consulted. */
function dnsHost(
  recorded: Recorded[],
  options: { readonly link?: string | null; readonly failAt?: number } = {}
): LinuxDnsHost {
  return {
    readFile: (path) =>
      Promise.resolve(
        path === "/etc/resolv.conf" ? "nameserver 127.0.0.53\n" : null
      ),
    listDir: () => Promise.resolve([]),
    isResolvedActive: () => Promise.resolve(true),
    systemdVersion: () => Promise.resolve(255),
    findLinkWithAddress: () =>
      Promise.resolve(
        options.link === undefined ? "br-0123456789ab" : options.link
      ),
    readLinkRoute: () => Promise.resolve(null),
    unitNeedsReload: () => Promise.resolve(false),
    runPrivileged: (argv, opts) =>
      runTrustedSudo(argv, {
        fs: sudoFs,
        ...(opts?.input === undefined ? {} : { input: opts.input }),
        runner: (spawned) => {
          recorded.push({ argv: spawned });
          return Promise.resolve(recorded.length === options.failAt ? 17 : 0);
        },
        inputRunner: (spawned, input) => {
          recorded.push({ argv: spawned, input: input.input });
          return Promise.resolve(recorded.length === options.failAt ? 17 : 0);
        },
      }),
  };
}

function macSnapshot(
  overrides: Partial<MacInstallSnapshot> = {}
): MacInstallSnapshot {
  return {
    brew: BREW,
    dnsmasqInstalled: true,
    services: "dnsmasq stopped root\n",
    helperPath: HELPER,
    helperInstalled: false,
    resolverDomains: DOMAINS,
    authorization: null,
    authorizationRefusal: null,
    ...overrides,
  };
}

function deps(overrides: Partial<InstallPlanDeps> = {}): InstallPlanDeps {
  return {
    platform: "linux",
    refusal: () => null,
    preflight: () => Promise.resolve(null),
    domains: DOMAINS,
    useStaticIps: () => Promise.resolve(true),
    linuxHost: dnsHost([]),
    sudoPath: () => Promise.resolve(SUDO),
    unreadableLinux: () => false,
    macSnapshot: () => Promise.resolve(macSnapshot()),
    trust: () =>
      Promise.resolve({
        schema: "hack.global-admin-plan.v1",
        command: "trust",
        platform: "darwin",
        refused: null,
        complete: true,
        blocked: [],
        steps: [],
      }),
    ...overrides,
  };
}

function rootSteps(plan: AdminPlan) {
  return plan.steps.flatMap((step) =>
    step.privilege === "root" && step.argv !== undefined
      ? [{ ...step, argv: step.argv }]
      : []
  );
}

test("Linux install plan equals the confirmed DNS execution at the fake sudo spawn boundary", async () => {
  const recorded: Recorded[] = [];
  const host = dnsHost(recorded);
  const plan = await planGlobalInstall(deps({ linuxHost: host }));
  expect(plan).toMatchObject({
    command: "install",
    complete: true,
    refused: null,
  });
  expect(recorded).toEqual([]);
  expect(
    plan.steps.slice(0, 4).every((step) => step.privilege === "user")
  ).toBe(true);

  await applyLinuxDns({
    host,
    domains: DOMAINS,
    canPrompt: true,
    show: () => undefined,
    confirm: () => Promise.resolve(true),
  });
  const planned = rootSteps(plan);
  expect(recorded.length).toBeGreaterThan(2);
  expect(recorded.map((step) => step.argv)).toEqual(
    planned.map((step) => step.argv)
  );
  expect(recorded[0]?.argv.slice(0, 7)).toEqual([
    SUDO,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG=C",
    "LC_ALL=C",
    "/bin/sh",
  ]);
  expect(
    recorded.map((step) =>
      step.input === undefined
        ? null
        : {
            bytes: step.input.byteLength,
            sha256: createHash("sha256").update(step.input).digest("hex"),
          }
    )
  ).toEqual(
    planned.map((step) =>
      step.stdin === undefined
        ? null
        : {
            bytes: step.stdin.bytes,
            sha256: step.stdin.sha256,
          }
    )
  );
  expect(
    planned.every((step) => step.shell && step.when.includes("confirm"))
  ).toBe(true);
});

test("Linux DNS execution stops on a failed planned root step", async () => {
  const recorded: Recorded[] = [];
  const host = dnsHost(recorded, { failAt: 2 });
  const plan = await planGlobalInstall(deps({ linuxHost: host }));
  const outcome = await applyLinuxDns({
    host,
    domains: DOMAINS,
    canPrompt: true,
    show: () => undefined,
    confirm: () => Promise.resolve(true),
  });
  expect(outcome).toMatchObject({ status: "failed", exitCode: 17 });
  expect(recorded.map((step) => step.argv)).toEqual(
    rootSteps(plan)
      .slice(0, 2)
      .map((step) => step.argv)
  );
});

test("install refuses before probing, and unknown network, bridge, resolver or sudo state invents no root argv", async () => {
  const refused = await planGlobalInstall(
    deps({
      refusal: () => "unavailable",
      preflight: () => {
        throw new Error("refusal must short circuit");
      },
    })
  );
  expect(refused).toMatchObject({ refused: "unavailable", steps: [] });
  const unknowns: Partial<InstallPlanDeps>[] = [
    { useStaticIps: () => Promise.resolve("unknown") },
    { linuxHost: dnsHost([], { link: null }) },
    { unreadableLinux: () => true },
    { sudoPath: () => Promise.resolve(null) },
  ];
  for (const unknown of unknowns) {
    const plan = await planGlobalInstall(deps(unknown));
    expect(plan.complete).toBe(false);
    expect(plan.blocked.length).toBeGreaterThan(0);
    expect(rootSteps(plan)).toEqual([]);
  }
  const skipped = await planGlobalInstall(
    deps({ useStaticIps: () => Promise.resolve(false) })
  );
  expect(skipped.complete).toBe(true);
  expect(rootSteps(skipped)).toEqual([]);
  expect(skipped.steps.some((step) => step.id === "skip-dns")).toBe(true);
});

test("macOS install plans terminal retry alternatives even with non-TTY planning stdin", async () => {
  const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
  try {
    for (const interactive of [false, true]) {
      const plan = await planGlobalInstall(
        deps({
          platform: "darwin",
          macSnapshot: () => Promise.resolve(macSnapshot()),
        })
      );
      const recorded: string[][] = [];
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: interactive,
      });
      const exit = await executeMacPrivilegedCommand({
        command: [BREW, "services", "restart", "dnsmasq"],
        interactive,
        runner: (argv, opts) => {
          recorded.push([...argv]);
          expect(opts?.stdin).toBe(
            recorded.length === 1 ? "ignore" : "inherit"
          );
          return Promise.resolve(recorded.length === 1 ? 1 : 0);
        },
      });
      expect(exit).toBe(interactive ? 0 : 1);
      expect(
        rootSteps(plan)
          .filter((step) => step.id.startsWith("global-up-restart"))
          .filter((_, index) => interactive || index === 0)
          .map((step) => step.argv)
      ).toEqual(recorded);
      expect(
        rootSteps(plan)
          .filter((step) => step.id.startsWith("dns-bootstrap-restart"))
          .filter((_, index) => interactive || index === 0)
          .map((step) => step.argv)
      ).toEqual(recorded);
      expect(rootSteps(plan)[0]?.shell).toContain(
        "'/opt/Example Tools/bin/brew'"
      );
      expect(
        plan.steps.findIndex((step) => step.id.startsWith("global-up-restart"))
      ).toBeLessThan(
        plan.steps.findIndex((step) => step.id === "global-stack")
      );
      expect(
        rootSteps(plan)
          .filter((step) => step.id.startsWith("resolver"))
          .map((step) => step.argv)
      ).toEqual(
        DOMAINS.map((domain) => [
          "sudo",
          "sh",
          "-c",
          `mkdir -p /etc/resolver && printf '%s\\n' 'nameserver 127.0.0.1' > /etc/resolver/${domain}`,
        ])
      );
      expect(
        rootSteps(plan)
          .filter((step) => step.id.startsWith("dns-flush"))
          .map((step) => step.argv)
      ).toEqual([
        ["sudo", "-n", "/usr/bin/dscacheutil", "-flushcache"],
        ["sudo", "/usr/bin/dscacheutil", "-flushcache"],
        ["sudo", "-n", "/usr/bin/killall", "-HUP", "mDNSResponder"],
        ["sudo", "/usr/bin/killall", "-HUP", "mDNSResponder"],
      ]);
      expect(
        rootSteps(plan).find((step) => step.id === "global-up-restart-1-2")
          ?.when
      ).toContain("only on an interactive terminal");
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: false,
      });
    }
  } finally {
    if (originalTty) {
      Object.defineProperty(process.stdin, "isTTY", originalTty);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }
});

test("macOS successful passwordless attempt does not run the interactive alternative", async () => {
  const recorded: string[][] = [];
  expect(
    await executeMacPrivilegedCommand({
      command: [HELPER, "flush-cache"],
      interactive: true,
      runner: (argv) => {
        recorded.push([...argv]);
        return Promise.resolve(0);
      },
    })
  ).toBe(0);
  expect(recorded).toEqual([["sudo", "-n", HELPER, "flush-cache"]]);
});

test("macOS helper fallback, retained resolver, authorization gates and no-brew cases remain explicit", async () => {
  const snapshot = macSnapshot({
    helperInstalled: true,
    resolverDomains: [],
    authorization: {
      helperPath: HELPER,
      helperTempPath: "<hack-home>/tmp/helper",
      sudoersPath: "/etc/sudoers.d/example",
      sudoersTempPath: "<hack-home>/tmp/example.sudoers",
      visudo: "/usr/sbin/visudo",
    },
  });
  const plan = await planGlobalInstall(
    deps({ platform: "darwin", macSnapshot: () => Promise.resolve(snapshot) })
  );
  const root = rootSteps(plan);
  expect(
    root
      .filter((step) => step.id.startsWith("global-up-restart"))
      .map((step) => step.argv)
  ).toEqual([
    ["sudo", "-n", HELPER, "restart-dnsmasq"],
    ["sudo", HELPER, "restart-dnsmasq"],
    ["sudo", "-n", BREW, "services", "restart", "dnsmasq"],
    ["sudo", BREW, "services", "restart", "dnsmasq"],
  ]);
  expect(root.filter((step) => step.id.startsWith("resolver"))).toEqual([]);
  expect(
    root
      .filter((step) => step.id.startsWith("dns-flush"))
      .map((step) => step.argv)
  ).toEqual([
    ["sudo", "-n", HELPER, "flush-cache"],
    ["sudo", HELPER, "flush-cache"],
  ]);
  expect(
    root
      .filter((step) => step.id.startsWith("recovery-"))
      .map((step) => step.argv)
  ).toEqual([
    [
      "sudo",
      "install",
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      "/Library/Example",
    ],
    [
      "sudo",
      "install",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      "<hack-home>/tmp/helper",
      HELPER,
    ],
    [
      "sudo",
      "install",
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      "/etc/sudoers.d",
    ],
    [
      "sudo",
      "install",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0440",
      "<hack-home>/tmp/example.sudoers",
      "/etc/sudoers.d/example",
    ],
    ["sudo", "/usr/sbin/visudo", "-cf", "/etc/sudoers.d/example"],
    ["sudo", "-k"],
    ["sudo", "-n", HELPER, "check"],
  ]);
  expect(
    root
      .filter((step) => step.id.startsWith("recovery-"))
      .every((step) => step.when.includes("confirm"))
  ).toBe(true);
  const noBrew = await planGlobalInstall(
    deps({
      platform: "darwin",
      macSnapshot: () =>
        Promise.resolve(
          macSnapshot({
            brew: null,
            dnsmasqInstalled: false,
            authorizationRefusal: "Homebrew absent",
          })
        ),
    })
  );
  expect(rootSteps(noBrew)).toEqual([]);
});

test("macOS unknown service or formula state and a future CA keep the plan incomplete", async () => {
  for (const unknown of [
    { services: null },
    { dnsmasqInstalled: "unknown" as const },
  ]) {
    const plan = await planGlobalInstall(
      deps({
        platform: "darwin",
        macSnapshot: () => Promise.resolve(macSnapshot(unknown)),
      })
    );
    expect(plan.complete).toBe(false);
    expect(
      rootSteps(plan).filter((step) => step.id.startsWith("global-up-restart"))
    ).toEqual([]);
  }
  const defaults = deps();
  const plan = await planGlobalInstall(
    deps({
      platform: "darwin",
      trust: async () => ({
        ...(await defaults.trust()),
        complete: false,
        blocked: [
          {
            phase: "keychain trust",
            reason: "CA created during bootstrap",
            prerequisite: "Export CA",
          },
        ],
      }),
    })
  );
  expect(plan.complete).toBe(false);
  expect(plan.blocked).toContainEqual({
    phase: "keychain trust",
    reason: "CA created during bootstrap",
    prerequisite: "Export CA",
  });
});

test("macOS embedded trust steps preserve the install plan's global order and gate identifiers", async () => {
  const defaults = deps();
  const plan = await planGlobalInstall(
    deps({
      platform: "darwin",
      trust: async () => ({
        ...(await defaults.trust()),
        steps: [
          {
            order: 1,
            privilege: "root",
            id: "probe",
            description: "Probe",
            argv: ["sudo", "-n", "true"],
            shell: "sudo -n true",
            when: "after confirmation",
            gates: "keychain-trust",
          },
          {
            order: 2,
            privilege: "root",
            id: "keychain-trust",
            description: "Trust",
            argv: ["sudo", "security", "add-trusted-cert"],
            shell: "sudo security add-trusted-cert",
            when: "after probe succeeds",
          },
        ],
      }),
    })
  );
  expect(plan.steps.map((step) => step.order)).toEqual(
    plan.steps.map((_, index) => index + 1)
  );
  expect(plan.steps.find((step) => step.id === "install-probe")?.gates).toBe(
    "install-keychain-trust"
  );
});

test("macOS unknown recovery ownership cannot be reported as a definite skipped phase", async () => {
  const plan = await planGlobalInstall(
    deps({
      platform: "darwin",
      macSnapshot: () =>
        Promise.resolve(
          macSnapshot({
            authorizationUnknown: true,
            authorizationRefusal: "Ownership unavailable",
          })
        ),
    })
  );
  expect(plan.complete).toBe(false);
  expect(
    plan.blocked.some((phase) => phase.phase === "recovery authorization")
  ).toBe(true);
  expect(
    rootSteps(plan).filter((step) => step.id.startsWith("recovery-"))
  ).toEqual([]);
});
