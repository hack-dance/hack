import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_GATEWAY,
} from "../src/constants.ts";
import {
  detectLinuxResolver,
  LINUX_DNS_UDEV_RULE_PATH,
  LINUX_DNS_UNIT_PATH,
  type LinuxLinkRoute,
  NM_DNSMASQ_HACK_PATH,
  parseLinkForAddress,
  parseNetworkManagerDnsMode,
  parseResolvectlLinkValues,
  parseSystemdVersion,
  renderLinuxDnsUdevRule,
  renderLinuxDnsUnit,
} from "../src/lib/linux-dns.ts";
import { createLinuxDnsHost } from "../src/lib/linux-dns-host.ts";
import {
  applyLinuxDns,
  inspectLinuxDns,
  type LinuxDnsHost,
  removeLinuxDns,
  renderPrivilegedCommand,
  sha256Hex,
  VERIFIED_INSTALL_SCRIPT,
} from "../src/lib/linux-dns-setup.ts";
import { restoreEnv } from "./helpers/env.ts";

const DOMAINS = ["hack", "hack.local", "hack.gy"] as const;
const STUB_RESOLV = "nameserver 127.0.0.53\noptions edns0 trust-ad\n";
const BRIDGE = "br-0123456789ab";

type FakeHostState = {
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  resolvedActive: boolean;
  link: string | null;
  routes: Map<string, LinuxLinkRoute>;
  staged: Map<string, string>;
  privileged: string[][];
  systemdVersion: number | null;
  /** Fail the first privileged command whose argv starts with this. */
  failOn?: string;
};

/**
 * In-memory host. Privileged commands mutate the fake `/etc` and link state
 * the way the real commands would, so a re-inspection sees their effect.
 */
function createFakeHost(init: Partial<FakeHostState> = {}): {
  readonly host: LinuxDnsHost;
  readonly state: FakeHostState;
} {
  const state: FakeHostState = {
    files: init.files ?? new Map([["/etc/resolv.conf", STUB_RESOLV]]),
    dirs: init.dirs ?? new Map(),
    resolvedActive: init.resolvedActive ?? true,
    link: init.link === undefined ? BRIDGE : init.link,
    routes: init.routes ?? new Map(),
    staged: new Map(),
    privileged: [],
    systemdVersion:
      init.systemdVersion === undefined ? 255 : init.systemdVersion,
    failOn: init.failOn,
  };
  const host: LinuxDnsHost = {
    readFile: async (path) => state.files.get(path) ?? null,
    listDir: async (path) => state.dirs.get(path) ?? [],
    isResolvedActive: async () => state.resolvedActive,
    systemdVersion: async () => state.systemdVersion,
    findLinkWithAddress: async (address) =>
      address === DEFAULT_INGRESS_GATEWAY ? state.link : null,
    readLinkRoute: async (link) =>
      state.routes.get(link) ?? { dns: [], domains: [], defaultRoute: true },
    stageFile: async ({ name, content }) => {
      const path = `/fake-stage/${name}`;
      state.staged.set(path, content);
      return path;
    },
    runPrivileged: async (argv) => {
      state.privileged.push([...argv]);
      if (state.failOn && argv.join(" ").startsWith(state.failOn)) {
        return 1;
      }
      const [verb] = argv;
      if (verb === "sh" && argv[3] === "hack-install") {
        // Mirrors VERIFIED_INSTALL_SCRIPT: install only bytes whose digest
        // matches the approved one.
        const [, , , , source = "", digest = "", target = ""] = argv;
        const content = state.staged.get(source) ?? "";
        if (sha256Hex(content) !== digest) {
          return 1;
        }
        state.files.set(target, content);
      } else if (verb === "rm") {
        for (const path of argv.slice(2)) {
          state.files.delete(path);
        }
      } else if (verb === "systemctl" && argv[1] === "restart") {
        const link = /^hack-dns@(.+)\.service$/.exec(argv[2] ?? "")?.[1];
        const unit = state.files.get(LINUX_DNS_UNIT_PATH);
        if (link && unit && link === state.link) {
          state.routes.set(link, routeFromUnit(unit));
        }
      } else if (verb === "resolvectl" && argv[1] === "revert") {
        state.routes.delete(argv[2] ?? "");
      }
      return 0;
    },
  };
  return { host, state };
}

/** What the unit's resolvectl calls would set on the link. */
function routeFromUnit(unit: string): LinuxLinkRoute {
  const dns = /resolvectl dns "\$\$1" ([^;]+);/.exec(unit)?.[1] ?? "";
  const domains =
    /resolvectl domain "\$\$1" ([^;]+);/
      .exec(unit)?.[1]
      ?.split(" ")
      .map((word) => word.replaceAll('"', "")) ?? [];
  return { dns: [dns], domains, defaultRoute: false };
}

function configuredFiles(domains: readonly string[] = DOMAINS) {
  return new Map([
    ["/etc/resolv.conf", STUB_RESOLV],
    [LINUX_DNS_UNIT_PATH, renderLinuxDnsUnit({ domains })],
    [LINUX_DNS_UDEV_RULE_PATH, renderLinuxDnsUdevRule()],
  ]);
}

const appliedRoute = (
  domains: readonly string[] = DOMAINS
): LinuxLinkRoute => ({
  dns: [DEFAULT_COREDNS_IP],
  domains: domains.map((domain) => `~${domain}`),
  defaultRoute: false,
});

describe("detectLinuxResolver", () => {
  test("resolved with the stub in resolv.conf", () => {
    expect(
      detectLinuxResolver({
        resolvedActive: true,
        resolvConf: STUB_RESOLV,
        nsswitchConf: null,
        networkManagerConf: null,
      })
    ).toEqual({
      kind: "systemd-resolved-stub",
      nameservers: ["127.0.0.53"],
      lookupsBypassResolved: false,
    });
  });

  test("resolved without the stub reports whether nsswitch reaches it", () => {
    const base = {
      resolvedActive: true,
      resolvConf: "nameserver 192.0.2.1\n",
      networkManagerConf: null,
    };
    expect(
      detectLinuxResolver({
        ...base,
        nsswitchConf: "hosts: files resolve [!UNAVAIL=return] dns\n",
      })
    ).toMatchObject({ kind: "systemd-resolved", lookupsBypassResolved: false });
    expect(
      detectLinuxResolver({ ...base, nsswitchConf: "hosts: files dns\n" })
    ).toMatchObject({ kind: "systemd-resolved", lookupsBypassResolved: true });
  });

  test("NetworkManager dnsmasq, plain resolv.conf and none", () => {
    expect(
      detectLinuxResolver({
        resolvedActive: false,
        resolvConf: "nameserver 127.0.0.1\n",
        nsswitchConf: null,
        networkManagerConf: "[main]\nplugins=keyfile\n\n[main]\ndns=dnsmasq\n",
      }).kind
    ).toBe("networkmanager-dnsmasq");
    expect(
      detectLinuxResolver({
        resolvedActive: false,
        resolvConf: "nameserver 192.0.2.1\n",
        nsswitchConf: null,
        networkManagerConf: null,
      }).kind
    ).toBe("resolv-conf");
    expect(
      detectLinuxResolver({
        resolvedActive: false,
        resolvConf: null,
        nsswitchConf: null,
        networkManagerConf: null,
      }).kind
    ).toBe("none");
  });

  test("NetworkManager precedence: vendor and /run snippets before NetworkManager.conf, /etc after", async () => {
    const files = new Map([
      ["/etc/resolv.conf", "nameserver 127.0.0.1\n"],
      ["/etc/NetworkManager/NetworkManager.conf", "[main]\ndns=dnsmasq\n"],
      [
        "/usr/lib/NetworkManager/conf.d/10-vendor.conf",
        "[main]\ndns=systemd-resolved\n",
      ],
    ]);
    const dirs = new Map([
      ["/usr/lib/NetworkManager/conf.d", ["10-vendor.conf"]],
    ]);
    const vendorOnly = createFakeHost({ resolvedActive: false, files, dirs });
    expect(
      (await inspectLinuxDns({ host: vendorOnly.host, domains: DOMAINS }))
        .resolver.kind
    ).toBe("networkmanager-dnsmasq");

    // An /etc snippet is parsed after NetworkManager.conf and wins.
    const etcFiles = new Map(files);
    etcFiles.set(
      "/etc/NetworkManager/conf.d/90-local.conf",
      "[main]\ndns=default\n"
    );
    const etcDirs = new Map(dirs);
    etcDirs.set("/etc/NetworkManager/conf.d", ["90-local.conf"]);
    const withEtc = createFakeHost({
      resolvedActive: false,
      files: etcFiles,
      dirs: etcDirs,
    });
    expect(
      (await inspectLinuxDns({ host: withEtc.host, domains: DOMAINS })).resolver
        .kind
    ).not.toBe("networkmanager-dnsmasq");

    // Same name: /etc shadows the vendor snippet entirely.
    const shadowFiles = new Map(files);
    shadowFiles.set(
      "/etc/NetworkManager/conf.d/10-vendor.conf",
      "[logging]\nlevel=INFO\n"
    );
    const shadowDirs = new Map(dirs);
    shadowDirs.set("/etc/NetworkManager/conf.d", ["10-vendor.conf"]);
    const shadowed = createFakeHost({
      resolvedActive: false,
      files: shadowFiles,
      dirs: shadowDirs,
    });
    expect(
      (await inspectLinuxDns({ host: shadowed.host, domains: DOMAINS }))
        .resolver.kind
    ).toBe("networkmanager-dnsmasq");
  });

  test("NetworkManager dns= outside [main] and later overrides", () => {
    expect(parseNetworkManagerDnsMode("[logging]\ndns=dnsmasq\n")).toBeNull();
    expect(
      parseNetworkManagerDnsMode(
        "[main]\ndns=dnsmasq\n[main]\ndns=systemd-resolved\n"
      )
    ).toBe("systemd-resolved");
  });
});

describe("rendered route files", () => {
  test("unit routes every suffix without naming a bridge", () => {
    const unit = renderLinuxDnsUnit({ domains: [...DOMAINS, "example.test"] });
    expect(unit).toContain(`resolvectl dns "$$1" ${DEFAULT_COREDNS_IP};`);
    expect(unit).toContain(
      'resolvectl domain "$$1" "~hack" "~hack.local" "~hack.gy" "~example.test";'
    );
    expect(unit).toContain('resolvectl default-route "$$1" no;');
    expect(unit).toContain(`grep -qF " inet ${DEFAULT_INGRESS_GATEWAY}/"`);
    // systemd < 243 ignores ExecCondition=; the bridge check must not rely on it.
    expect(unit).not.toContain("ExecCondition");
    expect(unit.match(/^ExecStart=/gm)).toHaveLength(1);
    expect(unit).not.toContain("br-");
    expect(renderLinuxDnsUdevRule()).toContain(
      'ENV{SYSTEMD_WANTS}+="hack-dns@%k.service"'
    );
  });

  test("ExecStart script is valid sh, and skips a bridge without the gateway", async () => {
    const unit = renderLinuxDnsUnit({ domains: DOMAINS });
    const line = unit
      .split("\n")
      .find((entry) => entry.startsWith("ExecStart="));
    const script = /\/bin\/sh -ec '(.*)' hack-dns %i$/.exec(line ?? "")?.[1];
    expect(script).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-dns-"));
    try {
      const shell = (script ?? "").replaceAll("$$", "$");
      const path = join(dir, "route.sh");
      await writeFile(path, `${shell}\n`);
      const syntax = Bun.spawn(["sh", "-n", path], { stderr: "pipe" });
      expect(await syntax.exited).toBe(0);

      // Fake ip/resolvectl on PATH: ip reports no gateway, resolvectl records calls.
      const bin = join(dir, "bin");
      const calls = join(dir, "calls");
      await mkdir(bin);
      await writeFile(join(bin, "ip"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await writeFile(
        join(bin, "resolvectl"),
        `#!/bin/sh\necho "$*" >> ${calls}\n`,
        { mode: 0o755 }
      );
      const env = { PATH: `${bin}:/usr/bin:/bin` };
      const skipped = Bun.spawn(["sh", "-ec", shell, "hack-dns", "br-other"], {
        env,
      });
      expect(await skipped.exited).toBe(0);
      expect(await Bun.file(calls).exists()).toBe(false);

      await writeFile(
        join(bin, "ip"),
        `#!/bin/sh\necho "7: br-x    inet ${DEFAULT_INGRESS_GATEWAY}/16 brd 172.30.255.255 scope global br-x"\n`,
        { mode: 0o755 }
      );
      const applied = Bun.spawn(["sh", "-ec", shell, "hack-dns", "br-x"], {
        env,
      });
      expect(await applied.exited).toBe(0);
      expect((await Bun.file(calls).text()).trim().split("\n")).toEqual([
        `dns br-x ${DEFAULT_COREDNS_IP}`,
        "domain br-x ~hack ~hack.local ~hack.gy",
        "default-route br-x no",
        "dnssec br-x no",
        "dnsovertls br-x no",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parsers", () => {
  test("ip -o -4 addr show", () => {
    const output = [
      "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever",
      `7: ${BRIDGE}    inet ${DEFAULT_INGRESS_GATEWAY}/16 brd 172.30.255.255 scope global ${BRIDGE}\\       valid_lft forever`,
    ].join("\n");
    expect(
      parseLinkForAddress({
        ipOutput: output,
        address: DEFAULT_INGRESS_GATEWAY,
      })
    ).toBe(BRIDGE);
    expect(
      parseLinkForAddress({ ipOutput: output, address: "172.30.0.10" })
    ).toBeNull();
  });

  test("systemctl --version", () => {
    expect(
      parseSystemdVersion("systemd 255 (255.4-1ubuntu8.18)\n+PAM +AUDIT")
    ).toBe(255);
    expect(parseSystemdVersion("systemd 239 (239-82.el8)")).toBe(239);
    expect(parseSystemdVersion("garbage")).toBeNull();
  });

  test("resolvectl link values", () => {
    expect(
      parseResolvectlLinkValues(`Link 7 (${BRIDGE}): ~hack ~hack.local\n`)
    ).toEqual(["~hack", "~hack.local"]);
    expect(parseResolvectlLinkValues(`Link 7 (${BRIDGE}):\n`)).toEqual([]);
  });
});

describe("applyLinuxDns", () => {
  test("fresh install shows the plan, asks once and installs both files", async () => {
    const { host, state } = createFakeHost();
    const shown: string[][] = [];
    let asked = 0;
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: (plan) => shown.push(plan.files.map((file) => file.path)),
      confirm: async () => {
        asked += 1;
        return true;
      },
    });
    expect(outcome.status).toBe("configured");
    expect(asked).toBe(1);
    expect(shown).toEqual([[LINUX_DNS_UNIT_PATH, LINUX_DNS_UDEV_RULE_PATH]]);
    expect(state.privileged.map((argv) => argv.slice(0, 2).join(" "))).toEqual([
      "sh -c",
      "sh -c",
      "systemctl daemon-reload",
      "udevadm control",
      "systemctl restart",
    ]);
    expect(state.privileged.at(-1)).toEqual([
      "systemctl",
      "restart",
      `hack-dns@${BRIDGE}.service`,
    ]);
    expect(state.files.get(LINUX_DNS_UNIT_PATH)).toBe(
      renderLinuxDnsUnit({ domains: DOMAINS })
    );
  });

  test("already configured changes nothing and does not prompt", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => {
        throw new Error("no plan expected");
      },
      confirm: async () => {
        throw new Error("no prompt expected");
      },
    });
    expect(outcome.status).toBe("configured");
    expect(state.privileged).toEqual([]);
    expect(state.staged.size).toBe(0);
  });

  test("drifted config (new default_domain) is reported stale and rewritten", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const domains = [...DOMAINS, "example.test"];
    const before = await inspectLinuxDns({ host, domains });
    expect(before).toMatchObject({
      state: "stale",
      code: "linux_dns_route_stale",
    });
    const outcome = await applyLinuxDns({
      host,
      domains,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(outcome.status).toBe("configured");
    expect(state.files.get(LINUX_DNS_UNIT_PATH)).toContain("~example.test");
  });

  test("files present but link not routed only restarts the unit", async () => {
    const { host, state } = createFakeHost({ files: configuredFiles() });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(outcome.status).toBe("configured");
    expect(state.privileged).toEqual([
      ["systemctl", "restart", `hack-dns@${BRIDGE}.service`],
    ]);
  });

  test("non-interactive returns the commands with a stable code and runs nothing", async () => {
    const { host, state } = createFakeHost();
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: false,
      show: () => {
        throw new Error("the caller prints the pending plan once");
      },
      confirm: async () => {
        throw new Error("must not prompt");
      },
    });
    expect(outcome.status).toBe("pending");
    if (outcome.status !== "pending") {
      return;
    }
    expect(outcome.code).toBe("linux_dns_route_missing");
    expect(state.privileged).toEqual([]);
    expect(outcome.plan.commands.map(renderPrivilegedCommand)[0]).toBe(
      `sudo sh -c '${VERIFIED_INSTALL_SCRIPT.replaceAll("'", "'\\''")}' hack-install /fake-stage/hack-dns@.service ${sha256Hex(renderLinuxDnsUnit({ domains: DOMAINS }))} ${LINUX_DNS_UNIT_PATH}`
    );
  });

  test("declined prompt is pending, not applied", async () => {
    const { host, state } = createFakeHost();
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => false,
    });
    expect(outcome.status).toBe("pending");
    expect(state.privileged).toEqual([]);
  });

  test("resolved inactive gives manual steps and never prompts", async () => {
    const { host, state } = createFakeHost({
      resolvedActive: false,
      files: new Map([["/etc/resolv.conf", "nameserver 192.0.2.1\n"]]),
    });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => {
        throw new Error("no plan expected");
      },
      confirm: async () => {
        throw new Error("no prompt expected");
      },
    });
    expect(outcome.status).toBe("manual");
    if (outcome.status !== "manual") {
      return;
    }
    expect(outcome.inspection.code).toBe("linux_dns_resolver_manual");
    expect(outcome.inspection.resolver.kind).toBe("resolv-conf");
    expect(outcome.inspection.fix.join("\n")).toContain(
      "sudo systemctl enable --now systemd-resolved"
    );
    expect(state.privileged).toEqual([]);
  });

  test("NetworkManager dnsmasq: manual steps, then configured once routed", async () => {
    const files = new Map([
      ["/etc/resolv.conf", "nameserver 127.0.0.1\n"],
      ["/etc/NetworkManager/NetworkManager.conf", "[main]\ndns=dnsmasq\n"],
    ]);
    const { host, state } = createFakeHost({ resolvedActive: false, files });
    const manual = await inspectLinuxDns({ host, domains: DOMAINS });
    expect(manual.state).toBe("manual");
    expect(manual.fix.join("\n")).toContain(NM_DNSMASQ_HACK_PATH);
    expect(manual.fix.join("\n")).toContain(
      `server=/hack.gy/${DEFAULT_COREDNS_IP}`
    );

    state.dirs.set("/etc/NetworkManager/dnsmasq.d", ["hack.conf"]);
    state.files.set(
      NM_DNSMASQ_HACK_PATH,
      DOMAINS.map((domain) => `server=/${domain}/${DEFAULT_COREDNS_IP}`).join(
        "\n"
      )
    );
    expect((await inspectLinuxDns({ host, domains: DOMAINS })).state).toBe(
      "configured"
    );
  });

  test("no bridge (Docker Desktop, rootless, network down) and nothing installed: no prompt, no root files", async () => {
    const { host, state } = createFakeHost({ link: null });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => {
        throw new Error("no plan expected");
      },
      confirm: async () => {
        throw new Error("no prompt expected");
      },
    });
    expect(outcome.status).toBe("manual");
    if (outcome.status !== "manual") {
      return;
    }
    expect(outcome.inspection.code).toBe("linux_dns_bridge_missing");
    expect(state.privileged).toEqual([]);
    expect(state.staged.size).toBe(0);
  });

  test("installed files but the bridge is gone reports bridge_missing", async () => {
    const { host } = createFakeHost({ link: null, files: configuredFiles() });
    expect(await inspectLinuxDns({ host, domains: DOMAINS })).toMatchObject({
      state: "bridge_missing",
      code: "linux_dns_bridge_missing",
    });
  });

  test("systemd older than 240 is manual and never prompts", async () => {
    const { host, state } = createFakeHost({ systemdVersion: 239 });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => {
        throw new Error("no plan expected");
      },
      confirm: async () => {
        throw new Error("no prompt expected");
      },
    });
    expect(outcome.status).toBe("manual");
    if (outcome.status === "manual") {
      expect(outcome.inspection.code).toBe("linux_dns_systemd_too_old");
    }
    expect(state.privileged).toEqual([]);
  });

  test("bypassed resolver: the plan says so before the prompt", async () => {
    const files = new Map([
      ["/etc/resolv.conf", "nameserver 192.0.2.1\n"],
      ["/etc/nsswitch.conf", "hosts: files dns\n"],
    ]);
    const { host } = createFakeHost({ files });
    const notes: string[] = [];
    await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: (plan) => notes.push(...(plan.notes ?? [])),
      confirm: async () => false,
    });
    expect(notes.join("\n")).toContain("bypass systemd-resolved");
  });

  test("a staged file replaced after approval is not installed", async () => {
    const { host, state } = createFakeHost();
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => {
        // Another process swaps the user-writable staged unit after display.
        state.staged.set(
          "/fake-stage/hack-dns@.service",
          "[Service]\nExecStart=/bin/sh -c 'malicious'\n"
        );
        return true;
      },
    });
    expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
    expect(state.files.has(LINUX_DNS_UNIT_PATH)).toBe(false);
  });

  test("the root install script installs approved bytes and refuses others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-dns-install-"));
    try {
      const bin = join(dir, "bin");
      await mkdir(bin);
      // Fake install(1): copy the last-but-one argument to the last one.
      await writeFile(
        join(bin, "install"),
        '#!/bin/sh\nfor a; do s="$t"; t="$a"; done; cp "$s" "$t"\n',
        { mode: 0o755 }
      );
      const stage = join(dir, "stage.service");
      const target = join(dir, "target.service");
      const approved = "[Unit]\nDescription=ok\n";
      await writeFile(stage, approved);
      const env = { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir };
      const run = (digest: string) =>
        Bun.spawn(
          [
            "sh",
            "-c",
            VERIFIED_INSTALL_SCRIPT,
            "hack-install",
            stage,
            digest,
            target,
          ],
          { env, stderr: "ignore" }
        ).exited;

      expect(await run(sha256Hex(approved))).toBe(0);
      expect(await Bun.file(target).text()).toBe(approved);

      await rm(target);
      await writeFile(stage, "[Unit]\nDescription=swapped\n");
      expect(await run(sha256Hex(approved))).not.toBe(0);
      expect(await Bun.file(target).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failing privileged step stops and reports it", async () => {
    const { host, state } = createFakeHost({
      failOn: "systemctl daemon-reload",
    });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(outcome).toMatchObject({
      status: "failed",
      failedCommand: ["systemctl", "daemon-reload"],
      exitCode: 1,
    });
    expect(state.privileged).toHaveLength(3);
  });

  test("resolved reached only through nsswitch-less resolv.conf is flagged", async () => {
    const files = configuredFiles();
    files.set("/etc/resolv.conf", "nameserver 192.0.2.1\n");
    files.set("/etc/nsswitch.conf", "hosts: files dns\n");
    const { host } = createFakeHost({
      files,
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    expect(await inspectLinuxDns({ host, domains: DOMAINS })).toMatchObject({
      state: "manual",
      code: "linux_dns_resolved_bypassed",
    });
  });
});

describe("removeLinuxDns", () => {
  test("reverts a link that still carries an older domain set", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute(["hack", "old.example"])]]),
    });
    const outcome = await removeLinuxDns({ host, confirm: async () => true });
    expect(outcome.status).toBe("removed");
    expect(state.privileged[0]).toEqual(["resolvectl", "revert", BRIDGE]);
  });

  test("files gone but the link still points at CoreDNS: revert only", async () => {
    const { host, state } = createFakeHost({
      routes: new Map([
        [
          BRIDGE,
          { dns: [DEFAULT_COREDNS_IP], domains: [], defaultRoute: null },
        ],
      ]),
    });
    const outcome = await removeLinuxDns({ host, confirm: async () => true });
    expect(outcome.status).toBe("removed");
    expect(state.privileged).toEqual([["resolvectl", "revert", BRIDGE]]);
  });

  test("reverts the link and deletes both files after confirmation", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const outcome = await removeLinuxDns({
      host,
      confirm: async () => true,
    });
    expect(outcome.status).toBe("removed");
    expect(state.privileged).toEqual([
      ["resolvectl", "revert", BRIDGE],
      ["rm", "-f", LINUX_DNS_UNIT_PATH, LINUX_DNS_UDEV_RULE_PATH],
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"],
    ]);
    expect((await inspectLinuxDns({ host, domains: DOMAINS })).state).toBe(
      "missing"
    );
  });

  test("declined or absent changes nothing", async () => {
    const configured = createFakeHost({ files: configuredFiles() });
    expect(
      (
        await removeLinuxDns({
          host: configured.host,
          confirm: async () => false,
        })
      ).status
    ).toBe("declined");
    expect(configured.state.privileged).toEqual([]);

    const absent = createFakeHost();
    expect(
      (
        await removeLinuxDns({
          host: absent.host,
          confirm: async () => {
            throw new Error("no prompt expected");
          },
        })
      ).status
    ).toBe("absent");
  });
});

describe("createLinuxDnsHost", () => {
  test("missing probe executables degrade to unavailable instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-dns-path-"));
    const savedPath = process.env.PATH;
    // An empty PATH: systemctl, ip and resolvectl all fail to spawn (ENOENT),
    // as on OpenRC hosts without systemctl.
    process.env.PATH = dir;
    try {
      const host = createLinuxDnsHost({ stageDir: join(dir, "stage") });
      expect(await host.isResolvedActive()).toBe(false);
      expect(await host.systemdVersion()).toBeNull();
      expect(
        await host.findLinkWithAddress(DEFAULT_INGRESS_GATEWAY)
      ).toBeNull();
      expect(await host.readLinkRoute("br-0123456789ab")).toBeNull();
    } finally {
      restoreEnv("PATH", savedPath);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
