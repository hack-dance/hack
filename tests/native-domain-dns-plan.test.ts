import { expect, test } from "bun:test";
import {
  type NativeDnsFileSnapshot,
  type NativeDnsPlanOptions,
  planNativeDomainDns,
} from "../src/lib/native-domain-dns-plan.ts";

const INCLUDE_DIR = "/opt/homebrew/etc/dnsmasq.d";
const RESOLVER_DIR = "/etc/resolver";
const MAIN_CONFIG = "/opt/homebrew/etc/dnsmasq.conf";
const V4_CONFIG = [
  "# v4 DNS remains in the main file",
  "address=/.hack/172.30.0.2",
  "address=/.hack.local/172.30.0.2",
  "address=/.hack.gy/172.30.0.2",
  "# retain user configuration",
  "address=/.unrelated.test/192.0.2.42",
  "",
].join("\n");

function file(path: string, content: string): NativeDnsFileSnapshot {
  return { path, content };
}

function options(
  overrides: Partial<NativeDnsPlanOptions> = {}
): NativeDnsPlanOptions {
  return {
    domain: "project.example.test",
    mainConfig: file(MAIN_CONFIG, V4_CONFIG),
    includeDir: INCLUDE_DIR,
    includeFiles: [],
    resolverDir: RESOLVER_DIR,
    resolverFiles: [],
    hosts: file("/etc/hosts", "127.0.0.1 localhost\n"),
    dnsmasqArgs: ["/opt/homebrew/sbin/dnsmasq", "-7", `${INCLUDE_DIR},*.conf`],
    receipt: null,
    ...overrides,
  };
}

test("plans isolated v5 claims while leaving v4 main configuration untouched", () => {
  const input = options();
  const before = input.mainConfig.content;
  const plan = planNativeDomainDns(input);
  expect(plan.status).toBe("available");
  expect(plan.dnsmasqPath).toBe(
    "/opt/homebrew/etc/dnsmasq.d/hack-native-project.example.test.conf"
  );
  expect(plan.resolverPath).toBe("/etc/resolver/project.example.test");
  expect(plan.dnsmasqContent).toBe(
    "address=/.project.example.test/127.0.0.1\n"
  );
  expect(plan.resolverContent).toBe("nameserver 127.0.0.1\n");
  expect(plan.activation).toContain(
    "Restart dnsmasq and flush the host DNS cache"
  );
  expect(input.mainConfig.content).toBe(before);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.pendingReceipt)).toBe(true);
  expect(plan.pendingReceipt.state).toBe("pending");
  expect(plan.activeReceipt.state).toBe("active");
  expect(plan.activeReceipt.dnsmasqSha256).toMatch(/^[a-f0-9]{64}$/);
});

for (const domain of ["hack", "hack.local", "hack.gy"]) {
  test(`refuses exact built-in root ${domain}`, () => {
    expect(() => planNativeDomainDns(options({ domain }))).toThrow(
      "canonical custom domain"
    );
  });
}

for (const domain of ["v5.hack", "v5.hack.local"]) {
  test(`refuses unsupported built-in child ${domain}`, () => {
    expect(() => planNativeDomainDns(options({ domain }))).toThrow(
      "cannot nest"
    );
  });
}

for (const claim of [
  "address=/.project.example.test/192.0.2.42",
  "address=/.example.test/192.0.2.42",
  "address=/.child.project.example.test/192.0.2.42",
  "server=/project.example.test/8.8.8.8",
]) {
  test(`refuses foreign dnsmasq claim ${claim}`, () => {
    expect(() =>
      planNativeDomainDns(
        options({
          mainConfig: file(MAIN_CONFIG, `${V4_CONFIG}${claim}\n`),
        })
      )
    ).toThrow("overlapping dnsmasq");
  });
}

test("refuses a second include claim and duplicate managed output path", () => {
  const first = planNativeDomainDns(options());
  expect(() =>
    planNativeDomainDns(
      options({
        includeFiles: [
          file(
            "/opt/homebrew/etc/dnsmasq.d/foreign.conf",
            first.dnsmasqContent
          ),
        ],
      })
    )
  ).toThrow("overlapping dnsmasq");
  expect(() =>
    planNativeDomainDns(
      options({
        includeFiles: [
          file(first.dnsmasqPath, first.dnsmasqContent),
          file(first.dnsmasqPath, first.dnsmasqContent),
        ],
      })
    )
  ).toThrow("duplicate directory snapshot path");
  expect(() =>
    planNativeDomainDns(
      options({
        includeFiles: [
          file(
            `${INCLUDE_DIR}/HACK-NATIVE-PROJECT.EXAMPLE.TEST.conf`,
            first.dnsmasqContent
          ),
        ],
      })
    )
  ).toThrow("case-variant collision");
});

test("matching public files require an exact active private receipt", () => {
  const first = planNativeDomainDns(options());
  const files = {
    includeFiles: [file(first.dnsmasqPath, first.dnsmasqContent)],
    resolverFiles: [file(first.resolverPath, first.resolverContent)],
  };
  expect(() => planNativeDomainDns(options(files))).toThrow("unowned");
  expect(() =>
    planNativeDomainDns(options({ ...files, receipt: first.pendingReceipt }))
  ).toThrow("do not match an active claim");
  expect(() =>
    planNativeDomainDns(
      options({
        ...files,
        receipt: { ...first.activeReceipt, dnsmasqSha256: "0".repeat(64) },
      })
    )
  ).toThrow("do not match an active claim");
  const active = planNativeDomainDns(
    options({ ...files, receipt: first.activeReceipt })
  );
  expect(active.status).toBe("active");
  expect(active.activation).toEqual([]);
});

test("refuses partial files, altered resolver contents, and foreign resolver names", () => {
  const first = planNativeDomainDns(options());
  expect(() =>
    planNativeDomainDns(
      options({ includeFiles: [file(first.dnsmasqPath, first.dnsmasqContent)] })
    )
  ).toThrow("partial");
  expect(() =>
    planNativeDomainDns(
      options({
        resolverFiles: [file(first.resolverPath, "nameserver 8.8.8.8\n")],
      })
    )
  ).toThrow("overlapping resolver");
  expect(() =>
    planNativeDomainDns(
      options({
        resolverFiles: [
          file(`${RESOLVER_DIR}/example.test`, "nameserver 8.8.8.8\n"),
        ],
      })
    )
  ).toThrow("overlapping resolver");
  expect(() =>
    planNativeDomainDns(
      options({
        resolverFiles: [
          file(
            `${RESOLVER_DIR}/child.project.example.test`,
            "nameserver 8.8.8.8\n"
          ),
        ],
      })
    )
  ).toThrow("overlapping resolver");
});

test("refuses hosts-file claims inside the new suffix", () => {
  expect(() =>
    planNativeDomainDns(
      options({
        hosts: file(
          "/etc/hosts",
          "127.0.0.1 localhost app.project.example.test\n"
        ),
      })
    )
  ).toThrow("hosts-file claim");
});

test("requires the live dnsmasq include argument", () => {
  expect(() =>
    planNativeDomainDns(options({ dnsmasqArgs: ["dnsmasq", "--no-daemon"] }))
  ).toThrow("does not load");
});

test("refuses uninspected dnsmasq configuration sources", () => {
  expect(() =>
    planNativeDomainDns(
      options({
        dnsmasqArgs: [
          "dnsmasq",
          "-7",
          `${INCLUDE_DIR},*.conf`,
          "-C",
          "/tmp/other.conf",
        ],
      })
    )
  ).toThrow("uninspected dnsmasq main configuration");
  expect(() =>
    planNativeDomainDns(
      options({
        mainConfig: file(
          MAIN_CONFIG,
          `${V4_CONFIG}conf-file=/tmp/other.conf\n`
        ),
      })
    )
  ).toThrow("uninspected DNS files");
  expect(() =>
    planNativeDomainDns(
      options({
        mainConfig: file(
          MAIN_CONFIG,
          `${V4_CONFIG}conf-file = /tmp/other.conf\n`
        ),
      })
    )
  ).toThrow("uninspected DNS files");
  for (const directive of ["addn-hosts", "hostsdir"]) {
    expect(() =>
      planNativeDomainDns(
        options({
          mainConfig: file(
            MAIN_CONFIG,
            `${V4_CONFIG}${directive}=/tmp/other-hosts\n`
          ),
        })
      )
    ).toThrow("uninspected DNS files");
    expect(() =>
      planNativeDomainDns(
        options({
          dnsmasqArgs: [
            "dnsmasq",
            "-7",
            `${INCLUDE_DIR},*.conf`,
            `--${directive}=/tmp/other-hosts`,
          ],
        })
      )
    ).toThrow("uninspected dnsmasq hosts source");
  }
  expect(() =>
    planNativeDomainDns(
      options({
        dnsmasqArgs: ["dnsmasq", "-7", `${INCLUDE_DIR},*.conf`, "-H/tmp/hosts"],
      })
    )
  ).toThrow("uninspected dnsmasq hosts source");
});

test("refuses a generated filename that cannot fit a filesystem component", () => {
  const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(56)}.test`;
  expect(() => planNativeDomainDns(options({ domain }))).toThrow(
    "filename exceeds"
  );
});

test("permits v5.hack.gy only with an explicit verified v4 parent claim", () => {
  const nested = options({
    domain: "v5.hack.gy",
    resolverFiles: [file(`${RESOLVER_DIR}/hack.gy`, "nameserver 127.0.0.1\n")],
    builtInParentClaim: "hack.gy",
  });
  const plan = planNativeDomainDns(nested);
  expect(plan.dnsmasqContent).toBe("address=/.v5.hack.gy/127.0.0.1\n");
  expect(nested.mainConfig.content).toBe(V4_CONFIG);
  expect(() =>
    planNativeDomainDns({ ...nested, builtInParentClaim: undefined })
  ).toThrow("explicit parent claim");
  expect(() =>
    planNativeDomainDns({
      ...nested,
      resolverFiles: [file(`${RESOLVER_DIR}/hack.gy`, "nameserver 8.8.8.8\n")],
    })
  ).toThrow("parent resolver");
  expect(() =>
    planNativeDomainDns({
      ...nested,
      mainConfig: file(
        MAIN_CONFIG,
        V4_CONFIG.replace(
          "address=/.hack.gy/172.30.0.2",
          "address=/.hack.gy/8.8.8.8"
        )
      ),
    })
  ).toThrow("parent dnsmasq");
});
