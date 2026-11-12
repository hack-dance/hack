import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_GATEWAY,
} from "../src/constants.ts";
import {
  detectLinuxResolver,
  isConfigurableInterfaceName,
  LINUX_DNS_MARKER,
  LINUX_DNS_UDEV_RULE_PATH,
  LINUX_DNS_UNIT_PATH,
  type LinuxLinkRoute,
  NM_DNSMASQ_HACK_PATH,
  parseLinkForAddress,
  parseNetworkManagerDnsMode,
  parseResolvectlLinkValues,
  parseSystemdVersion,
  readLinuxDnsMarker,
  renderLinuxDnsUdevRule,
  renderLinuxDnsUnit,
} from "../src/lib/linux-dns.ts";
import {
  createLinuxDnsHost,
  parseNeedDaemonReload,
} from "../src/lib/linux-dns-host.ts";
import {
  applyLinuxDns,
  inspectLinuxDns,
  type LinuxDnsHost,
  type LinuxDnsPlan,
  removeLinuxDns,
  renderManualPlan,
} from "../src/lib/linux-dns-setup.ts";
import {
  STDIN_INSTALL_SCRIPT,
  sha256Hex,
} from "../src/lib/privileged-install.ts";
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
  privileged: string[][];
  /** stdin given to each privileged call (undefined when none). */
  inputs: (Uint8Array | undefined)[];
  systemdVersion: number | null;
  /** systemd's NeedDaemonReload for the unit; an install sets it. */
  needsReload: boolean | null;
  /** Fail the first privileged command whose argv starts with this. */
  failOn?: string;
};

/**
 * In-memory host. Privileged commands mutate the fake `/etc`, systemd and
 * link state the way the real commands would, so a re-inspection sees their
 * effect. Installs mirror the root stdin script's preconditions: content
 * only from stdin, exactly the declared byte count and digest.
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
    privileged: [],
    inputs: [],
    systemdVersion:
      init.systemdVersion === undefined ? 255 : init.systemdVersion,
    needsReload: init.needsReload === undefined ? false : init.needsReload,
    failOn: init.failOn,
  };
  const install = (argv: readonly string[], input?: Uint8Array): number => {
    const [, , script, name, bytes = "", digest = "", target = ""] = argv;
    expect(script).toBe(STDIN_INSTALL_SCRIPT);
    expect(name).toBe("hack-install");
    expect(argv).toHaveLength(8);
    if (input === undefined || input.byteLength !== Number(bytes)) {
      return 66;
    }
    if (sha256Hex(input) !== digest) {
      return 67;
    }
    state.files.set(target, new TextDecoder().decode(input));
    if (target === LINUX_DNS_UNIT_PATH) {
      state.needsReload = true;
    }
    return 0;
  };
  const host: LinuxDnsHost = {
    readFile: async (path) => state.files.get(path) ?? null,
    listDir: async (path) => state.dirs.get(path) ?? [],
    isResolvedActive: async () => state.resolvedActive,
    systemdVersion: async () => state.systemdVersion,
    findLinkWithAddress: async (address) =>
      address === DEFAULT_INGRESS_GATEWAY ? state.link : null,
    readLinkRoute: async (link) =>
      state.routes.get(link) ?? {
        dns: [],
        domains: [],
        defaultRoute: true,
        dnssec: null,
        dnsOverTls: null,
      },
    unitNeedsReload: async () => state.needsReload,
    runPrivileged: async (argv, opts) => {
      state.privileged.push([...argv]);
      state.inputs.push(opts?.input);
      if (state.failOn && argv.join(" ").startsWith(state.failOn)) {
        return 1;
      }
      const [verb] = argv;
      if (verb === "/bin/sh") {
        return install(argv, opts?.input);
      }
      expect(opts?.input).toBeUndefined();
      if (verb === "rm") {
        expect(argv.slice(0, 3)).toEqual(["rm", "-f", "--"]);
        for (const path of argv.slice(3)) {
          state.files.delete(path);
        }
      } else if (verb === "systemctl" && argv[1] === "stop") {
        expect(argv.slice(2)).toEqual(["--", "hack-dns@*.service"]);
      } else if (verb === "systemctl" && argv[1] === "daemon-reload") {
        state.needsReload = false;
      } else if (verb === "systemctl" && argv[1] === "restart") {
        expect(argv[2]).toBe("--");
        const link = /^hack-dns@(.+)\.service$/.exec(argv[3] ?? "")?.[1];
        const unit = state.files.get(LINUX_DNS_UNIT_PATH);
        if (link && unit && link === state.link) {
          state.routes.set(link, routeFromUnit(unit));
        }
      } else if (verb === "resolvectl" && argv[1] === "revert") {
        expect(argv[2]).toBe("--");
        state.routes.delete(argv[3] ?? "");
      }
      return 0;
    },
  };
  return { host, state };
}

/** What the unit's resolvectl calls would set on the link. */
function routeFromUnit(unit: string): LinuxLinkRoute {
  const dns = /resolvectl dns -- "\$\$1" ([^;]+);/.exec(unit)?.[1] ?? "";
  const domains =
    /resolvectl domain -- "\$\$1" ([^;]+);/
      .exec(unit)?.[1]
      ?.split(" ")
      .map((word) => word.replaceAll('"', "")) ?? [];
  return {
    dns: [dns],
    domains,
    defaultRoute: false,
    dnssec: "no",
    dnsOverTls: "no",
  };
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
  dnssec: "no",
  dnsOverTls: "no",
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
      search: [],
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

    // /run is parsed after /usr/lib even when the vendor name sorts later.
    const runFiles = new Map([
      ["/etc/resolv.conf", "nameserver 127.0.0.1\n"],
      [
        "/usr/lib/NetworkManager/conf.d/90-vendor.conf",
        "[main]\ndns=systemd-resolved\n",
      ],
      ["/run/NetworkManager/conf.d/10-runtime.conf", "[main]\ndns=dnsmasq\n"],
    ]);
    const runDirs = new Map([
      ["/usr/lib/NetworkManager/conf.d", ["90-vendor.conf"]],
      ["/run/NetworkManager/conf.d", ["10-runtime.conf"]],
    ]);
    const runtime = createFakeHost({
      resolvedActive: false,
      files: runFiles,
      dirs: runDirs,
    });
    expect(
      (await inspectLinuxDns({ host: runtime.host, domains: DOMAINS })).resolver
        .kind
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
    expect(unit).toContain(`resolvectl dns -- "$$1" ${DEFAULT_COREDNS_IP};`);
    expect(unit).toContain(
      'resolvectl domain -- "$$1" "~hack" "~hack.local" "~hack.gy" "~example.test";'
    );
    expect(unit).toContain('resolvectl default-route -- "$$1" no;');
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
        `dns -- br-x ${DEFAULT_COREDNS_IP}`,
        "domain -- br-x ~hack ~hack.local ~hack.gy",
        "default-route -- br-x no",
        "dnssec -- br-x no",
        "dnsovertls -- br-x no",
      ]);

      // An option-like name never reaches resolvectl.
      await rm(calls, { force: true });
      const optionLike = Bun.spawn(["sh", "-ec", shell, "hack-dns", "-h"], {
        env,
      });
      expect(await optionLike.exited).toBe(0);
      expect(await Bun.file(calls).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parsers", () => {
  test("ip -j -4 addr show gives the exact interface name", () => {
    const json = (ifname: string) =>
      JSON.stringify([
        {
          ifname: "lo",
          addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }],
        },
        {
          ifname,
          addr_info: [
            { family: "inet", local: DEFAULT_INGRESS_GATEWAY, prefixlen: 16 },
          ],
        },
      ]);
    expect(
      parseLinkForAddress({
        ipJson: json(BRIDGE),
        address: DEFAULT_INGRESS_GATEWAY,
      })
    ).toBe(BRIDGE);
    // Not truncated at "@" (the text form appends @peer to some names).
    expect(
      parseLinkForAddress({
        ipJson: json("br@blue"),
        address: DEFAULT_INGRESS_GATEWAY,
      })
    ).toBe("br@blue");
    expect(
      parseLinkForAddress({ ipJson: json(BRIDGE), address: "172.30.0.10" })
    ).toBeNull();
    expect(
      parseLinkForAddress({
        ipJson: "not json",
        address: DEFAULT_INGRESS_GATEWAY,
      })
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
      "/bin/sh -c",
      "/bin/sh -c",
      "systemctl daemon-reload",
      "udevadm control",
      "systemctl restart",
    ]);
    expect(state.privileged.at(-1)).toEqual([
      "systemctl",
      "restart",
      "--",
      `hack-dns@${BRIDGE}.service`,
    ]);
    // Only the two installs carry stdin; root is given no path to read.
    expect(state.inputs.map((input) => input !== undefined)).toEqual([
      true,
      true,
      false,
      false,
      false,
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

  test("files present but link not routed reloads and restarts, installing nothing", async () => {
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
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"],
      ["systemctl", "restart", "--", `hack-dns@${BRIDGE}.service`],
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
    const manual = renderManualPlan(outcome.plan);
    // Each file goes through the root stdin installer, never `tee`.
    expect(manual[0]).toStartWith("sudo /bin/sh -c 'set -eu; ");
    expect(manual[0]).toEndWith(
      `hack-install ${new TextEncoder().encode(renderLinuxDnsUnit({ domains: DOMAINS })).byteLength} ${sha256Hex(renderLinuxDnsUnit({ domains: DOMAINS }))} ${LINUX_DNS_UNIT_PATH} 0644 <<'HACK_DNS_FILE_END'`
    );
    expect(manual.some((line) => line.startsWith("sudo tee"))).toBe(false);
    expect(manual.join("\n")).toContain(
      renderLinuxDnsUnit({ domains: DOMAINS }).trimEnd()
    );
    expect(manual.slice(-3)).toEqual([
      "sudo systemctl daemon-reload",
      "sudo udevadm control --reload",
      `sudo systemctl restart -- hack-dns@${BRIDGE}.service`,
    ]);
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
    const fix = outcome.inspection.fix.join("\n");
    // No printed step replaces the host's static resolv.conf.
    expect(fix).not.toContain("ln -sf");
    expect(fix).not.toContain("/etc/resolv.conf\n");
    expect(fix).toContain(`server=/hack/${DEFAULT_COREDNS_IP}`);
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

  test("root gets the approved bytes on stdin; other bytes are refused", async () => {
    const { host, state } = createFakeHost();
    const tampering: LinuxDnsHost = {
      ...host,
      // Something between Hack and root alters the bytes in flight.
      runPrivileged: async (argv, opts) =>
        await host.runPrivileged(argv, {
          input:
            opts?.input === undefined
              ? undefined
              : new TextEncoder().encode(
                  new TextDecoder()
                    .decode(opts.input)
                    .replace("Type=oneshot", "Type=oneshoX")
                ),
        }),
    };
    const outcome = await applyLinuxDns({
      host: tampering,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(outcome).toMatchObject({
      status: "failed",
      failedStep: `install ${LINUX_DNS_UNIT_PATH}`,
      exitCode: 67,
    });
    expect(state.files.has(LINUX_DNS_UNIT_PATH)).toBe(false);
    // The install argv names the destination only; no source path exists.
    expect(state.privileged[0]?.slice(4)).toEqual([
      String(
        new TextEncoder().encode(renderLinuxDnsUnit({ domains: DOMAINS }))
          .byteLength
      ),
      sha256Hex(renderLinuxDnsUnit({ domains: DOMAINS })),
      LINUX_DNS_UNIT_PATH,
      "0644",
    ]);
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
      failedStep: "sudo systemctl daemon-reload",
      exitCode: 1,
    });
    expect(state.privileged).toHaveLength(3);

    // The retry sees matching files on disk but still repeats the reloads.
    state.failOn = undefined;
    state.privileged = [];
    const retry = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(retry.status).toBe("configured");
    expect(state.privileged).toEqual([
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"],
      ["systemctl", "restart", "--", `hack-dns@${BRIDGE}.service`],
    ]);
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

describe("review hardening", () => {
  test("a catch-all or extra routing domain, or an extra server, is not configured", async () => {
    for (const route of [
      { ...appliedRoute(), domains: [...appliedRoute().domains, "~."] },
      {
        ...appliedRoute(),
        domains: [...appliedRoute().domains, "corp.example"],
      },
      { ...appliedRoute(), dns: [DEFAULT_COREDNS_IP, "192.0.2.53"] },
      { ...appliedRoute(), defaultRoute: null },
    ]) {
      const { host } = createFakeHost({
        files: configuredFiles(),
        routes: new Map([[BRIDGE, route]]),
      });
      expect(await inspectLinuxDns({ host, domains: DOMAINS })).toMatchObject({
        state: "not_applied",
        code: "linux_dns_route_not_applied",
      });
    }
  });

  test("nsswitch: comments, order and return actions", () => {
    const uses = (nsswitch: string) =>
      !detectLinuxResolver({
        resolvedActive: true,
        resolvConf: "nameserver 192.0.2.1\n",
        nsswitchConf: nsswitch,
        networkManagerConf: null,
      }).lookupsBypassResolved;
    expect(uses("hosts: files dns # resolve\n")).toBe(false);
    expect(uses("# hosts: files resolve\nhosts: files dns\n")).toBe(false);
    expect(uses("hosts: files dns resolve\n")).toBe(false);
    expect(uses("hosts: files [NOTFOUND=return] resolve dns\n")).toBe(false);
    expect(
      uses("hosts: files mymachines resolve [!UNAVAIL=return] dns myhostname\n")
    ).toBe(true);
  });

  test("bypassed resolved: no resolver switch is printed, only forwarding and the guide", async () => {
    const files = configuredFiles();
    files.set(
      "/etc/resolv.conf",
      "nameserver 192.0.2.1\nsearch corp.example\n"
    );
    files.set("/etc/nsswitch.conf", "hosts: files dns\n");
    const { host } = createFakeHost({
      files,
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const inspection = await inspectLinuxDns({ host, domains: DOMAINS });
    expect(inspection.code).toBe("linux_dns_resolved_bypassed");
    const fix = inspection.fix.join("\n");
    for (const switchStep of [
      "ln -s",
      "resolv.conf.before-hack",
      "systemctl enable",
      "cp -P",
    ]) {
      expect(fix).not.toContain(switchStep);
    }
    expect(fix).toContain(`server=/hack/${DEFAULT_COREDNS_IP}`);
    expect(fix).toContain("docs/guides/linux-setup.md (Switching resolvers)");
  });

  test("interface names outside the safe set get manual steps and no prompt", async () => {
    for (const link of [
      "br%test",
      "br@blue",
      "-h",
      ".hidden",
      "a".repeat(16),
    ]) {
      const { host, state } = createFakeHost({ link });
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
        continue;
      }
      expect(outcome.inspection.code).toBe("linux_dns_interface_unsupported");
      expect(outcome.inspection.fix.join("\n")).toContain(
        `sudo resolvectl dns -- '${link}' ${DEFAULT_COREDNS_IP}`
      );
      expect(state.privileged).toEqual([]);
    }
    for (const link of ["docker0", BRIDGE, "br_x.1", "a".repeat(15)]) {
      expect(isConfigurableInterfaceName(link)).toBe(true);
    }
  });

  test("Hack's files are recognised by the first-line marker, any format version", () => {
    const unit = renderLinuxDnsUnit({ domains: DOMAINS });
    expect(unit.split("\n")[0]).toBe(LINUX_DNS_MARKER);
    expect(LINUX_DNS_MARKER).toContain("format=2");
    expect(readLinuxDnsMarker(unit)).toEqual({ kind: "known", format: 2 });
    expect(readLinuxDnsMarker(renderLinuxDnsUdevRule()).kind).toBe("known");
    expect(
      readLinuxDnsMarker(
        "# Managed by hack (hack global install), format=3. Remove with: hack global down\n"
      )
    ).toEqual({ kind: "unknown-format", format: 3 });
    // The unversioned marker of the first format (older Hack).
    expect(
      readLinuxDnsMarker(
        "# Managed by hack (hack global install). Remove with: hack global down\n[Unit]\n"
      )
    ).toEqual({ kind: "known", format: 1 });
    expect(readLinuxDnsMarker(`[Unit]\n${LINUX_DNS_MARKER}\n`).kind).toBe(
      "none"
    );
    expect(readLinuxDnsMarker("# Managed by someone else\n").kind).toBe("none");
  });
});

describe("removeLinuxDns", () => {
  const remove = (
    host: LinuxDnsHost,
    confirm: (plan: LinuxDnsPlan) => Promise<boolean> = async () => true
  ) => removeLinuxDns({ host, domains: DOMAINS, confirm });
  const LEGACY_MARKER =
    "# Managed by hack (hack global install). Remove with: hack global down";

  test("reverts the link and deletes both files after confirmation", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const outcome = await remove(host);
    expect(outcome).toEqual({ status: "removed", leftInPlace: [] });
    // Files and reloads first, then stop running instances, then revert, so
    // nothing re-applies the route after the revert.
    expect(state.privileged).toEqual([
      ["rm", "-f", "--", LINUX_DNS_UNIT_PATH, LINUX_DNS_UDEV_RULE_PATH],
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"],
      ["systemctl", "stop", "--", "hack-dns@*.service"],
      ["resolvectl", "revert", "--", BRIDGE],
    ]);
    expect((await inspectLinuxDns({ host, domains: DOMAINS })).state).toBe(
      "missing"
    );
  });

  test("files from an older Hack (unversioned marker, older template) are removed", async () => {
    const files = configuredFiles();
    files.set(
      LINUX_DNS_UNIT_PATH,
      `${LEGACY_MARKER}\n[Unit]\nDescription=Hack split DNS on %i\n[Service]\nExecStart=/bin/sh -ec 'old' hack-dns %i\n`
    );
    files.set(
      LINUX_DNS_UDEV_RULE_PATH,
      `${LEGACY_MARKER}\nACTION=="add", ENV{SYSTEMD_WANTS}+="hack-dns@%k.service"\n`
    );
    const { host, state } = createFakeHost({ files });
    expect((await inspectLinuxDns({ host, domains: DOMAINS })).state).toBe(
      "stale"
    );
    const outcome = await remove(host);
    expect(outcome).toEqual({ status: "removed", leftInPlace: [] });
    expect(state.files.has(LINUX_DNS_UNIT_PATH)).toBe(false);
    expect(state.files.has(LINUX_DNS_UDEV_RULE_PATH)).toBe(false);
  });

  test("files without Hack's marker are left in place and described", async () => {
    const files = configuredFiles();
    files.set(LINUX_DNS_UNIT_PATH, "[Unit]\nDescription=someone else's\n");
    files.set(LINUX_DNS_UDEV_RULE_PATH, "# someone else's rule\n");
    const { host, state } = createFakeHost({ files });
    const outcome = await remove(host, async () => {
      throw new Error("nothing of Hack's to remove: no prompt");
    });
    expect(outcome.status).toBe("absent");
    expect(outcome.leftInPlace).toHaveLength(2);
    expect(outcome.leftInPlace.join("\n")).toContain(
      `sudo rm -- ${LINUX_DNS_UNIT_PATH}`
    );
    expect(state.privileged).toEqual([]);
    expect(state.files.has(LINUX_DNS_UNIT_PATH)).toBe(true);
  });

  test("a marker with a format this build does not know is reported and left", async () => {
    const files = configuredFiles();
    files.set(
      LINUX_DNS_UNIT_PATH,
      "# Managed by hack (hack global install), format=999. Remove with: hack global down\n[Unit]\n"
    );
    const { host, state } = createFakeHost({ files });
    const outcome = await remove(host);
    expect(outcome.status).toBe("removed");
    // Only the known-format rule was deleted.
    expect(state.privileged[0]).toEqual([
      "rm",
      "-f",
      "--",
      LINUX_DNS_UDEV_RULE_PATH,
    ]);
    expect(state.files.has(LINUX_DNS_UNIT_PATH)).toBe(true);
    expect(outcome.leftInPlace.join("\n")).toContain("format=999");
  });

  test("only Hack's file is removed when the other has no marker", async () => {
    const files = configuredFiles();
    files.set(LINUX_DNS_UDEV_RULE_PATH, "# someone else's rule\n");
    const { host, state } = createFakeHost({ files });
    expect((await remove(host)).status).toBe("removed");
    expect(state.privileged[0]).toEqual([
      "rm",
      "-f",
      "--",
      LINUX_DNS_UNIT_PATH,
    ]);
    expect(state.files.get(LINUX_DNS_UDEV_RULE_PATH)).toBe(
      "# someone else's rule\n"
    );
  });

  test("a link whose servers are Hack's is reverted; other settings on it are listed first", async () => {
    const route: LinuxLinkRoute = {
      ...appliedRoute(),
      domains: [...appliedRoute().domains, "~corp.example"],
      dnssec: "allow-downgrade",
    };
    const { host, state } = createFakeHost({
      routes: new Map([[BRIDGE, route]]),
    });
    const notes: string[] = [];
    const outcome = await remove(host, async (plan) => {
      notes.push(...(plan.notes ?? []));
      return true;
    });
    expect(outcome.status).toBe("removed");
    expect(state.privileged).toEqual([
      ["systemctl", "stop", "--", "hack-dns@*.service"],
      ["resolvectl", "revert", "--", BRIDGE],
    ]);
    expect(notes.join("\n")).toContain("~corp.example");
    expect(notes.join("\n")).toContain("dnssec allow-downgrade");
  });

  test("a link with other servers next to CoreDNS is left alone and reported", async () => {
    const { host, state } = createFakeHost({
      routes: new Map([
        [
          BRIDGE,
          { ...appliedRoute(), dns: [DEFAULT_COREDNS_IP, "192.0.2.53"] },
        ],
      ]),
    });
    const outcome = await remove(host, async () => {
      throw new Error("no prompt expected");
    });
    expect(outcome.status).toBe("absent");
    expect(outcome.leftInPlace.join("\n")).toContain(
      `sudo resolvectl revert -- ${BRIDGE}`
    );
    expect(state.privileged).toEqual([]);
  });

  test("a bridge name outside the policy is reported with the manual revert", async () => {
    const { host, state } = createFakeHost({ link: "br%test" });
    const outcome = await remove(host, async () => {
      throw new Error("no prompt expected");
    });
    expect(outcome.status).toBe("absent");
    expect(outcome.leftInPlace.join("\n")).toContain(
      "sudo resolvectl revert -- 'br%test'"
    );
    expect(state.privileged).toEqual([]);
  });

  test("declined or absent changes nothing", async () => {
    const configured = createFakeHost({ files: configuredFiles() });
    expect((await remove(configured.host, async () => false)).status).toBe(
      "declined"
    );
    expect(configured.state.privileged).toEqual([]);

    const absent = createFakeHost();
    expect(
      await remove(absent.host, async () => {
        throw new Error("no prompt expected");
      })
    ).toEqual({ status: "absent", leftInPlace: [] });
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
      const host = createLinuxDnsHost();
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

describe("bootstrapLinuxGlobalDns result (install exit status)", () => {
  async function withIsolatedHome(run: () => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), "hack-linux-dns-home-"));
    const saved = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_DATA_HOME = join(home, ".local", "share");
    try {
      await run();
    } finally {
      restoreEnv("HOME", saved.HOME);
      restoreEnv("XDG_CONFIG_HOME", saved.XDG_CONFIG_HOME);
      restoreEnv("XDG_DATA_HOME", saved.XDG_DATA_HOME);
      await rm(home, { recursive: true, force: true });
    }
  }

  test("configured, skipped (declined or no prompt) and failed (confirmed step failed)", async () => {
    await withIsolatedHome(async () => {
      const { bootstrapLinuxGlobalDns } = await import(
        "../src/commands/global-linux-dns.ts"
      );
      const run = (
        init: Partial<FakeHostState>,
        prompt: { canPrompt: boolean; confirm: () => Promise<boolean> }
      ) => {
        const { host, state } = createFakeHost(init);
        return {
          state,
          result: bootstrapLinuxGlobalDns({ useStaticIps: true, host, prompt }),
        };
      };
      const yes = { canPrompt: true, confirm: async () => true };
      expect(await run({}, yes).result).toBe("configured");
      const declined = run({}, { canPrompt: true, confirm: async () => false });
      expect(await declined.result).toBe("skipped");
      expect(declined.state.privileged).toEqual([]);
      const noPrompt = run(
        {},
        {
          canPrompt: false,
          confirm: async () => {
            throw new Error("must not prompt");
          },
        }
      );
      expect(await noPrompt.result).toBe("skipped");
      expect(noPrompt.state.privileged).toEqual([]);
      expect(await run({ failOn: "udevadm control" }, yes).result).toBe(
        "failed"
      );
      expect(await run({ resolvedActive: false }, yes).result).toBe("skipped");
    });
  });
});

describe("review round two", () => {
  test("DNS-over-TLS or DNSSEC drift on the link is not configured, and a repair fixes it", async () => {
    for (const drift of [
      { dnsOverTls: "yes" },
      { dnsOverTls: "opportunistic" },
      { dnssec: "allow-downgrade" },
      { dnssec: null },
    ]) {
      const { host, state } = createFakeHost({
        files: configuredFiles(),
        routes: new Map([[BRIDGE, { ...appliedRoute(), ...drift }]]),
      });
      expect(await inspectLinuxDns({ host, domains: DOMAINS })).toMatchObject({
        state: "not_applied",
        code: "linux_dns_route_not_applied",
      });
      const outcome = await applyLinuxDns({
        host,
        domains: DOMAINS,
        canPrompt: true,
        show: () => undefined,
        confirm: async () => true,
      });
      expect(outcome.status).toBe("configured");
      expect(state.routes.get(BRIDGE)).toEqual(appliedRoute());
    }
  });

  test("installing over a file without Hack's marker says so before the prompt", async () => {
    const files = configuredFiles();
    files.set(LINUX_DNS_UNIT_PATH, "[Unit]\nDescription=someone else's\n");
    const { host } = createFakeHost({ files });
    const notes: string[] = [];
    await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: (plan) => notes.push(...(plan.notes ?? [])),
      confirm: async () => false,
    });
    expect(notes.join("\n")).toContain(
      `${LINUX_DNS_UNIT_PATH} exists without Hack's marker`
    );
    expect(notes.join("\n")).not.toContain(LINUX_DNS_UDEV_RULE_PATH);
  });

  test("a pending daemon-reload is not configured even when the link matches", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
      needsReload: true,
    });
    expect(await inspectLinuxDns({ host, domains: DOMAINS })).toMatchObject({
      state: "not_applied",
      code: "linux_dns_reload_pending",
    });
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(outcome.status).toBe("configured");
    expect(state.privileged).toEqual([
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"],
      ["systemctl", "restart", "--", `hack-dns@${BRIDGE}.service`],
    ]);
    // Unknown reload state is a repair too, never "configured".
    const unknown = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
      needsReload: null,
    });
    expect(
      (await inspectLinuxDns({ host: unknown.host, domains: DOMAINS })).code
    ).toBe("linux_dns_reload_pending");
  });

  test("a failed reload after an install is repeated on retry", async () => {
    const { host, state } = createFakeHost({
      failOn: "systemctl daemon-reload",
    });
    const first = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(first.status).toBe("failed");
    expect(state.needsReload).toBe(true);
    // Even if the link already carried the route, the pending reload shows.
    state.routes.set(BRIDGE, appliedRoute());
    state.failOn = undefined;
    expect((await inspectLinuxDns({ host, domains: DOMAINS })).code).toBe(
      "linux_dns_reload_pending"
    );
    state.privileged = [];
    const retry = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(retry.status).toBe("configured");
    expect(state.privileged[0]).toEqual(["systemctl", "daemon-reload"]);
  });

  test("the unit's own script applies the interface-name policy", async () => {
    const unit = renderLinuxDnsUnit({ domains: DOMAINS });
    const line = unit
      .split("\n")
      .find((entry) => entry.startsWith("ExecStart="));
    const script = /\/bin\/sh -ec '(.*)' hack-dns %i$/.exec(line ?? "")?.[1];
    const shell = (script ?? "").replaceAll("$$", "$");
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-dns-names-"));
    try {
      const bin = join(dir, "bin");
      const calls = join(dir, "calls");
      await mkdir(bin);
      // ip reports the gateway on every name, so only the policy can stop it.
      await writeFile(
        join(bin, "ip"),
        `#!/bin/sh\necho "7: x    inet ${DEFAULT_INGRESS_GATEWAY}/16 scope global x"\n`,
        { mode: 0o755 }
      );
      await writeFile(
        join(bin, "resolvectl"),
        `#!/bin/sh\necho "$*" >> ${calls}\n`,
        { mode: 0o755 }
      );
      const run = async (name: string) =>
        await Bun.spawn(["sh", "-ec", shell, "hack-dns", name], {
          env: { PATH: `${bin}:/usr/bin:/bin` },
        }).exited;
      for (const name of [
        "",
        "-h",
        ".hidden",
        "br%test",
        "br@blue",
        "br test",
        "a".repeat(16),
      ]) {
        expect(await run(name)).toBe(0);
        expect(await Bun.file(calls).exists()).toBe(false);
        expect(isConfigurableInterfaceName(name)).toBe(false);
      }
      expect(await run("br_x.1-a")).toBe(0);
      expect((await readFile(calls, "utf8")).split("\n")[0]).toBe(
        `dns -- br_x.1-a ${DEFAULT_COREDNS_IP}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(renderLinuxDnsUdevRule()).toContain('KERNEL=="[A-Za-z0-9_]*"');
  });

  test("systemctl show NeedDaemonReload", () => {
    expect(parseNeedDaemonReload("NeedDaemonReload=no\n")).toBe(false);
    expect(parseNeedDaemonReload("NeedDaemonReload=yes\n")).toBe(true);
    expect(parseNeedDaemonReload("")).toBeNull();
  });

  test("the printed manual plan pastes into a shell as is", async () => {
    const home = await mkdtemp(join(tmpdir(), "hack-linux-dns-paste-"));
    const saved = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_DATA_HOME = join(home, ".local", "share");
    try {
      const { bootstrapLinuxGlobalDns } = await import(
        "../src/commands/global-linux-dns.ts"
      );
      const { managedLocalDomains, resolveDefaultDomain } = await import(
        "../src/lib/default-domain.ts"
      );
      const domains = managedLocalDomains(await resolveDefaultDomain());
      const { host } = createFakeHost();
      let printed = "";
      const result = await bootstrapLinuxGlobalDns({
        useStaticIps: true,
        host,
        print: (text) => {
          printed += text;
        },
        prompt: {
          canPrompt: false,
          confirm: async () => {
            throw new Error("must not prompt");
          },
        },
      });
      expect(result).toBe("skipped");
      // Raw: the heredoc terminator sits at column 0.
      expect(printed.split("\n")).toContain("HACK_DNS_FILE_END");

      const lines = printed.split("\n");
      expect(lines.some((line) => line.startsWith("sudo tee"))).toBe(false);
      expect(lines.some((line) => line.startsWith("sudo install"))).toBe(false);

      // The fake sudo runs each pasted installer command unchanged except that
      // the destination moves under `sandbox`: the real root stdin script
      // installs (as this user: chown, the ownership find and install's owner
      // flags are faked, as in tests/privileged-install.test.ts).
      const bin = join(home, "bin");
      const sandbox = join(home, "root");
      const log = join(home, "sudo.log");
      await mkdir(bin);
      await mkdir(sandbox);
      await writeFile(join(bin, "chown"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await writeFile(join(bin, "find"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await writeFile(
        join(bin, "install"),
        [
          "#!/bin/sh",
          'for a; do shift; case "$skip$a" in -o|-g) skip=1;; 1*) skip=;; *) set -- "$@" "$a";; esac; done',
          'exec /usr/bin/install "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      await writeFile(
        join(bin, "sudo"),
        [
          "#!/bin/sh",
          'if [ "$1" = /bin/sh ] && [ "$2" = -c ] && [ "$4" = hack-install ]; then',
          `  echo "install $7" >> "${log}"`,
          `  exec /bin/sh -c "$3" "$4" "$5" "$6" "${sandbox}$7" "$8"`,
          "fi",
          `echo "$*" >> "${log}"`,
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      const pasted = Bun.spawn(["sh", "-e"], {
        stdin: new Blob([printed]),
        env: { PATH: `${bin}:/usr/bin:/bin` },
        stderr: "pipe",
      });
      expect(await pasted.exited).toBe(0);
      expect(await readFile(join(sandbox, LINUX_DNS_UNIT_PATH), "utf8")).toBe(
        renderLinuxDnsUnit({ domains })
      );
      expect(
        await readFile(join(sandbox, LINUX_DNS_UDEV_RULE_PATH), "utf8")
      ).toBe(renderLinuxDnsUdevRule());
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        `install ${LINUX_DNS_UNIT_PATH}`,
        `install ${LINUX_DNS_UDEV_RULE_PATH}`,
        "systemctl daemon-reload",
        "udevadm control --reload",
        `systemctl restart -- hack-dns@${BRIDGE}.service`,
      ]);
    } finally {
      restoreEnv("HOME", saved.HOME);
      restoreEnv("XDG_CONFIG_HOME", saved.XDG_CONFIG_HOME);
      restoreEnv("XDG_DATA_HOME", saved.XDG_DATA_HOME);
      await rm(home, { recursive: true, force: true });
    }
  });
});
