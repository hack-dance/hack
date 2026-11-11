import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_GATEWAY,
} from "../src/constants.ts";
import {
  detectLinuxResolver,
  isConfigurableInterfaceName,
  LINUX_DNS_UDEV_RULE_PATH,
  LINUX_DNS_UNIT_PATH,
  type LinuxLinkRoute,
  NM_DNSMASQ_HACK_PATH,
  parseHackUnitDomains,
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
  renderManualPlan,
  renderVerifiedInstallScript,
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
  /** Every stageFiles call, in order; staging must follow confirmation. */
  stageCalls: number;
  /** Runs before each privileged install reads its staged copy. */
  beforeInstall?: (source: string) => void;
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
    stageCalls: 0,
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
    stageFiles: async (files) => {
      state.stageCalls += 1;
      // A new unique directory per call, like mkdtemp.
      const dir = `/fake-stage/${state.stageCalls}`;
      const paths = files.map((file) => {
        const path = `${dir}/${file.name}`;
        if (state.staged.has(path)) {
          throw new Error("exclusive create: path exists");
        }
        state.staged.set(path, file.content);
        return path;
      });
      return {
        paths,
        cleanup: async () => {
          for (const path of paths) {
            state.staged.delete(path);
          }
        },
      };
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
        state.beforeInstall?.(source);
        const content = state.staged.get(source) ?? "";
        if (sha256Hex(content) !== digest) {
          return 1;
        }
        state.files.set(target, content);
      } else if (verb === "rm") {
        expect(argv.slice(0, 3)).toEqual(["rm", "-f", "--"]);
        for (const path of argv.slice(3)) {
          state.files.delete(path);
        }
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
      "sh -c",
      "sh -c",
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
    // Staged once, after the single confirmation, and cleaned up.
    expect(state.stageCalls).toBe(1);
    expect(state.staged.size).toBe(0);
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
    expect(state.stageCalls).toBe(0);
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
    expect(state.stageCalls).toBe(0);
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
    // Nothing is staged without a confirmation: the printed steps carry the
    // file content themselves.
    expect(state.stageCalls).toBe(0);
    const manual = renderManualPlan(outcome.plan);
    expect(manual.slice(0, 2)).toEqual([
      "sudo install -d -m 0755 /etc/systemd/system",
      `sudo tee ${LINUX_DNS_UNIT_PATH} >/dev/null <<'HACK_DNS_FILE_END'`,
    ]);
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
    expect(state.stageCalls).toBe(0);
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
    expect(state.stageCalls).toBe(0);
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

  test("a staged file replaced before root copies it is not installed", async () => {
    const { host, state } = createFakeHost();
    // Another same-user process swaps the staged unit after staging.
    state.beforeInstall = (source) => {
      state.staged.set(source, "[Service]\nExecStart=/bin/sh -c 'malicious'\n");
    };
    const outcome = await applyLinuxDns({
      host,
      domains: DOMAINS,
      canPrompt: true,
      show: () => undefined,
      confirm: async () => true,
    });
    expect(outcome).toMatchObject({
      status: "failed",
      failedStep: `install ${LINUX_DNS_UNIT_PATH}`,
      exitCode: 1,
    });
    expect(state.files.has(LINUX_DNS_UNIT_PATH)).toBe(false);
    expect(state.staged.size).toBe(0);
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

  test("bypassed resolved: steps check upstreams, keep a backup and verify", async () => {
    const files = configuredFiles();
    files.set(
      "/etc/resolv.conf",
      "nameserver 192.0.2.1\nnameserver 192.0.2.2\nsearch corp.example lab.example\n"
    );
    files.set("/etc/nsswitch.conf", "hosts: files dns\n");
    const { host } = createFakeHost({
      files,
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const inspection = await inspectLinuxDns({ host, domains: DOMAINS });
    expect(inspection.code).toBe("linux_dns_resolved_bypassed");
    const fix = inspection.fix.join("\n");
    expect(fix).toContain("192.0.2.1 192.0.2.2");
    expect(fix).toContain("search corp.example lab.example");
    const backup = fix.indexOf(
      "sudo cp -P /etc/resolv.conf /etc/resolv.conf.before-hack"
    );
    const link = fix.indexOf(
      "sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf"
    );
    const verify = fix.indexOf("getent hosts example.com");
    expect(backup).toBeGreaterThan(fix.indexOf("resolvectl dns"));
    expect(link).toBeGreaterThan(backup);
    expect(verify).toBeGreaterThan(link);
    expect(fix).toContain(
      "sudo mv /etc/resolv.conf.before-hack /etc/resolv.conf"
    );
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

  test("the installed unit is recognized only when byte-for-byte Hack's", () => {
    const unit = renderLinuxDnsUnit({ domains: ["hack", "corp.test"] });
    expect(parseHackUnitDomains(unit)).toEqual(["hack", "corp.test"]);
    expect(parseHackUnitDomains(`${unit}\n`)).toBeNull();
    expect(
      parseHackUnitDomains(unit.replace("sleep 0.25", "sleep 1"))
    ).toBeNull();
    expect(parseHackUnitDomains("[Unit]\n")).toBeNull();
  });
});

describe("root install script bounds", () => {
  async function withScript(
    run: (opts: {
      readonly dir: string;
      readonly exec: (source: string, digest: string) => Promise<number>;
      readonly target: string;
    }) => Promise<void>
  ) {
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-dns-bounds-"));
    try {
      const bin = join(dir, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "install"),
        '#!/bin/sh\nfor a; do s="$t"; t="$a"; done; cp "$s" "$t"\n',
        { mode: 0o755 }
      );
      const target = join(dir, "target");
      const script = renderVerifiedInstallScript({
        maxBytes: 1024,
        timeoutSeconds: 1,
      });
      await run({
        dir,
        target,
        exec: async (source, digest) =>
          await Bun.spawn(
            ["sh", "-c", script, "hack-install", source, digest, target],
            {
              env: { PATH: `${bin}:/usr/bin:/bin` },
              stderr: "ignore",
            }
          ).exited,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a FIFO is refused, or killed by the time bound if swapped in after the check", async () => {
    await withScript(async ({ dir, exec, target }) => {
      const fifo = join(dir, "fifo");
      expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
      const started = Date.now();
      expect(await exec(fifo, sha256Hex(""))).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await Bun.file(target).exists()).toBe(false);
    });
    // The bounded copy itself (the check skipped): `timeout` ends a blocked open.
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-dns-fifo-"));
    try {
      const fifo = join(dir, "fifo");
      expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
      const started = Date.now();
      const code = await Bun.spawn(
        [
          "sh",
          "-c",
          `timeout -k 1 1 head -c 1025 -- "${fifo}" > "${dir}/copy"`,
        ],
        { stderr: "ignore" }
      ).exited;
      expect(code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a link to /dev/zero is refused, and an oversized file fails before install", async () => {
    await withScript(async ({ dir, exec, target }) => {
      const link = join(dir, "zero");
      await symlink("/dev/zero", link);
      expect(await exec(link, sha256Hex(""))).not.toBe(0);
      const big = join(dir, "big");
      const content = "x".repeat(2048);
      await writeFile(big, content);
      expect(await exec(big, sha256Hex(content))).not.toBe(0);
      expect(await exec("relative/path", sha256Hex(""))).not.toBe(0);
      expect(await Bun.file(target).exists()).toBe(false);
      const ok = join(dir, "ok");
      await writeFile(ok, "fine\n");
      expect(await exec(ok, sha256Hex("fine\n"))).toBe(0);
      expect(await Bun.file(target).text()).toBe("fine\n");
    });
  });

  test("the default script carries the default bounds", () => {
    expect(VERIFIED_INSTALL_SCRIPT).toContain(
      "timeout -k 1 10 head -c 65537 --"
    );
    expect(VERIFIED_INSTALL_SCRIPT).toContain('[ ! -L "$1" ]');
  });
});

describe("removeLinuxDns", () => {
  const remove = (host: LinuxDnsHost, confirm = async () => true) =>
    removeLinuxDns({ host, domains: DOMAINS, confirm });

  test("reverts the link and deletes both files after confirmation", async () => {
    const { host, state } = createFakeHost({
      files: configuredFiles(),
      routes: new Map([[BRIDGE, appliedRoute()]]),
    });
    const outcome = await remove(host);
    expect(outcome).toEqual({ status: "removed", leftInPlace: [] });
    expect(state.privileged).toEqual([
      ["resolvectl", "revert", "--", BRIDGE],
      ["rm", "-f", "--", LINUX_DNS_UNIT_PATH, LINUX_DNS_UDEV_RULE_PATH],
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"],
    ]);
    expect((await inspectLinuxDns({ host, domains: DOMAINS })).state).toBe(
      "missing"
    );
  });

  test("a route matching the installed unit's older domains is still Hack's", async () => {
    const older = ["hack", "old.example"];
    const { host, state } = createFakeHost({
      files: configuredFiles(older),
      routes: new Map([[BRIDGE, appliedRoute(older)]]),
    });
    expect((await remove(host)).status).toBe("removed");
    expect(state.privileged[0]).toEqual(["resolvectl", "revert", "--", BRIDGE]);
  });

  test("edited or foreign files are left in place and described", async () => {
    const files = configuredFiles();
    files.set(
      LINUX_DNS_UNIT_PATH,
      `${renderLinuxDnsUnit({ domains: DOMAINS })}# local edit\n`
    );
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

  test("only Hack's file is removed when the other is foreign", async () => {
    const files = configuredFiles();
    files.set(LINUX_DNS_UDEV_RULE_PATH, "# someone else's rule\n");
    const { host, state } = createFakeHost({ files });
    const outcome = await remove(host);
    expect(outcome.status).toBe("removed");
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

  test("a link with CoreDNS mixed into other settings is not reverted", async () => {
    for (const route of [
      { ...appliedRoute(), dns: [DEFAULT_COREDNS_IP, "192.0.2.53"] },
      {
        ...appliedRoute(),
        domains: [...appliedRoute().domains, "~corp.example"],
      },
      { dns: [DEFAULT_COREDNS_IP], domains: [], defaultRoute: null },
    ]) {
      const { host, state } = createFakeHost({
        routes: new Map([[BRIDGE, route]]),
      });
      const outcome = await remove(host, async () => {
        throw new Error("no prompt expected");
      });
      expect(outcome.status).toBe("absent");
      expect(outcome.leftInPlace.join("\n")).toContain(
        `sudo resolvectl revert -- ${BRIDGE}`
      );
      expect(state.privileged).toEqual([]);
    }
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
      const host = createLinuxDnsHost({ stageRoot: join(dir, "stage") });
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

describe("createLinuxDnsHost staging", () => {
  test("each call stages into a new private directory with exclusive files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-linux-dns-stage-"));
    try {
      const host = createLinuxDnsHost({ stageRoot: root });
      const first = await host.stageFiles([
        { name: "a.rules", content: "one\n" },
      ]);
      const second = await host.stageFiles([
        { name: "a.rules", content: "two\n" },
      ]);
      expect(first.paths[0]).not.toBe(second.paths[0]);
      const dir = join(first.paths[0] ?? "", "..");
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(first.paths[0] ?? "")).mode & 0o777).toBe(0o600);
      expect(await Bun.file(first.paths[0] ?? "").text()).toBe("one\n");
      // A duplicate name in one call is never written through.
      await expect(
        host.stageFiles([
          { name: "x", content: "1" },
          { name: "x", content: "2" },
        ])
      ).rejects.toThrow();
      await first.cleanup();
      await second.cleanup();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
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
