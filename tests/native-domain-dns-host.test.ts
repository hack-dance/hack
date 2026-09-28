import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateNativeDomainDns,
  NativeDnsUncertainEffectError,
} from "../src/lib/native-domain-dns-activate.ts";
import { deactivateNativeDomainDns } from "../src/lib/native-domain-dns-deactivate.ts";
import {
  createNativeDnsHostDependencies,
  type NativeDnsCommandRunner,
} from "../src/lib/native-domain-dns-host.ts";
import { planNativeDomainDns } from "../src/lib/native-domain-dns-plan.ts";
import { exec } from "../src/lib/shell.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(
  overrides: {
    readonly runCommand?: NativeDnsCommandRunner;
    readonly runPrivileged?: NativeDnsCommandRunner;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "native-dns-host-"));
  roots.push(root);
  const includeDir = join(root, "dnsmasq.d");
  const resolverDir = join(root, "resolver");
  const privateDir = join(root, "private");
  await Promise.all([
    mkdir(includeDir),
    mkdir(resolverDir),
    mkdir(privateDir, { mode: 0o700 }),
  ]);
  const mainPath = join(root, "dnsmasq.conf");
  const hostsPath = join(root, "hosts");
  const domain = "project.example.test";
  const plan = planNativeDomainDns({
    domain,
    mainConfig: { path: mainPath, content: `conf-dir=${includeDir},*.conf\n` },
    includeDir,
    includeFiles: [],
    resolverDir,
    resolverFiles: [],
    hosts: { path: hostsPath, content: "127.0.0.1 localhost\n" },
    dnsmasqArgs: ["dnsmasq", "-7", `${includeDir},*.conf`],
    receipt: null,
  });
  const receiptPath = join(privateDir, "native-dns.json");
  const commandCalls: string[][] = [];
  const privilegedCalls: string[][] = [];
  const runCommand: NativeDnsCommandRunner =
    overrides.runCommand ??
    (async (command) => {
      commandCalls.push([...command]);
      if (command[0] === "/usr/bin/dig") {
        return { exitCode: 0, stdout: "127.0.0.1\n", stderr: "" };
      }
      if (command[0] === "/usr/bin/dscacheutil") {
        return {
          exitCode: 0,
          stdout: "name: probe\nip_address: 127.0.0.1\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  const runPrivileged: NativeDnsCommandRunner =
    overrides.runPrivileged ??
    (async (command) => {
      privilegedCalls.push([...command]);
      return {
        exitCode: 0,
        stdout: command[7] === "create" ? "42:73\n" : "1\n",
        stderr: "",
      };
    });
  const dependencies = createNativeDnsHostDependencies({
    receiptPath,
    dnsmasqPath: plan.dnsmasqPath,
    resolverPath: plan.resolverPath,
    dnsmasqBinary: join(root, "dnsmasq"),
    dnsmasqMainConfigPath: mainPath,
    dnsmasqIncludeDir: includeDir,
    inspectPlan: async () => ({ plan, fingerprint: "snapshot" }),
    authorize: async () => true,
    restartDnsmasq: async () => {},
    flushDnsCache: async () => {},
    runCommand,
    runPrivileged,
  });
  return {
    root,
    plan,
    receiptPath,
    dependencies,
    commandCalls,
    privilegedCalls,
  };
}

test("private receipt is exclusive and transitions atomically with guarded clear", async () => {
  const f = await fixture();
  await f.dependencies.writeReceipt(f.plan.pendingReceipt);
  expect(await readFile(f.receiptPath, "utf8")).toBe(
    `${JSON.stringify(f.plan.pendingReceipt)}\n`
  );
  expect((await stat(f.receiptPath)).mode & 0o777).toBe(0o600);
  await f.dependencies.writeReceipt(f.plan.activeReceipt);
  expect(await f.dependencies.clearPendingReceipt(f.plan.pendingReceipt)).toBe(
    false
  );
  await f.dependencies.writeReceipt(f.plan.pendingReceipt);
  expect(await f.dependencies.clearPendingReceipt(f.plan.pendingReceipt)).toBe(
    true
  );
  await expect(readFile(f.receiptPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("deactivation receipt transitions cannot overwrite foreign or unexpected states", async () => {
  const f = await fixture();
  await f.dependencies.writeReceipt(f.plan.pendingReceipt);
  await f.dependencies.writeReceipt(f.plan.activeReceipt);
  await f.dependencies.writeReceipt(f.plan.removingReceipt);
  await f.dependencies.writeReceipt(f.plan.inactiveReceipt);
  expect(await readFile(f.receiptPath, "utf8")).toBe(
    `${JSON.stringify(f.plan.inactiveReceipt)}\n`
  );
  await f.dependencies.writeReceipt(f.plan.pendingReceipt);
  await f.dependencies.writeReceipt(f.plan.activeReceipt);
  await writeFile(f.receiptPath, "foreign\n");
  await expect(
    f.dependencies.writeReceipt(f.plan.removingReceipt)
  ).rejects.toThrow("changed");
  expect(await readFile(f.receiptPath, "utf8")).toBe("foreign\n");
});

test("foreign receipt is never overwritten and changed pending receipt is retained", async () => {
  const f = await fixture();
  await writeFile(f.receiptPath, "foreign\n");
  await expect(
    f.dependencies.writeReceipt(f.plan.pendingReceipt)
  ).rejects.toThrow("changed");
  expect(await readFile(f.receiptPath, "utf8")).toBe("foreign\n");
  await rm(f.receiptPath);
  await f.dependencies.writeReceipt(f.plan.pendingReceipt);
  await writeFile(f.receiptPath, "changed\n");
  expect(await f.dependencies.clearPendingReceipt(f.plan.pendingReceipt)).toBe(
    false
  );
  expect(await readFile(f.receiptPath, "utf8")).toBe("changed\n");
});

test("dnsmasq file create is exclusive and rollback requires same inode and content", async () => {
  const f = await fixture();
  const file = { path: f.plan.dnsmasqPath, content: f.plan.dnsmasqContent };
  const owned = await f.dependencies.createExclusive(file);
  await expect(f.dependencies.createExclusive(file)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await writeFile(file.path, "changed\n");
  expect(await f.dependencies.removeIfOwned(owned)).toBe(false);
  await rm(file.path);
  await writeFile(file.path, file.content);
  expect(await f.dependencies.removeIfOwned(owned)).toBe(false);
  expect(await readFile(file.path, "utf8")).toBe(file.content);
});

test("resolver effects use only the fixed noninteractive privileged command", async () => {
  const f = await fixture();
  const resolver = await f.dependencies.createExclusive({
    path: f.plan.resolverPath,
    content: f.plan.resolverContent,
  });
  expect(resolver.identity).toBe("42:73");
  expect(await f.dependencies.removeIfOwned(resolver)).toBe(true);
  expect(f.privilegedCalls).toHaveLength(2);
  for (const command of f.privilegedCalls) {
    expect(command.slice(0, 6)).toEqual([
      "sudo",
      "-n",
      "/usr/bin/python3",
      "-I",
      "-S",
      "-c",
    ]);
    expect(command[8]).toBe(f.plan.resolverPath);
    expect(command[6]).toContain("O_EXCL | os.O_NOFOLLOW");
    expect(command[6]).toContain("identity != expected");
  }
  expect(f.privilegedCalls[0]?.[7]).toBe("create");
  expect(f.privilegedCalls[1]?.[7]).toBe("remove");
  expect(f.privilegedCalls[1]?.[10]).toBe("42:73");
});

test("config and live verification use the active inputs and one random hostname", async () => {
  const f = await fixture();
  await f.dependencies.testConfig();
  await f.dependencies.verifyLiveDns(f.plan);
  expect(f.commandCalls).toHaveLength(3);
  expect(f.commandCalls[0]).toEqual([
    join(f.root, "dnsmasq"),
    "--test",
    `--conf-file=${join(f.root, "dnsmasq.conf")}`,
    `--conf-dir=${join(f.root, "dnsmasq.d")},*.conf`,
  ]);
  expect(f.commandCalls[1]?.[0]).toBe("/usr/bin/dig");
  expect(f.commandCalls[2]?.[0]).toBe("/usr/bin/dscacheutil");
  expect(f.commandCalls[1]?.[5]).toBe(f.commandCalls[2]?.[5]);
  expect(f.commandCalls[1]?.[5]).toMatch(
    /^hack-probe-[a-f0-9]{32}\.project\.example\.test$/
  );
});

test("system DNS mismatch fails verification", async () => {
  const f = await fixture({
    runCommand: async (command) => ({
      exitCode: 0,
      stdout:
        command[0] === "/usr/bin/dig"
          ? "127.0.0.1\n"
          : "ip_address: 127.0.0.2\n",
      stderr: "",
    }),
  });
  await expect(f.dependencies.verifyLiveDns(f.plan)).rejects.toThrow(
    "System DNS"
  );
});

test("deactivation requires exact direct and system parent fallback", async () => {
  const correct = await fixture({
    runCommand: async (command) => ({
      exitCode: 0,
      stdout:
        command[0] === "/usr/bin/dig"
          ? "172.30.0.2\n"
          : "name: probe\nip_address: 172.30.0.2\n",
      stderr: "",
    }),
  });
  await correct.dependencies.verifyDeactivatedDns({
    domain: "v5.hack.gy",
    parentAddress: "172.30.0.2",
  });

  const wrong = await fixture({
    runCommand: async (command) => ({
      exitCode: 0,
      stdout:
        command[0] === "/usr/bin/dig"
          ? "172.30.0.2\n"
          : "ip_address: 127.0.0.1\n",
      stderr: "",
    }),
  });
  await expect(
    wrong.dependencies.verifyDeactivatedDns({
      domain: "v5.hack.gy",
      parentAddress: "172.30.0.2",
    })
  ).rejects.toThrow("verified parent fallback");
});

test("deactivation without a parent refuses a remaining native loopback answer", async () => {
  const absent = await fixture({
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  await absent.dependencies.verifyDeactivatedDns(absent.plan);

  const lingering = await fixture();
  await expect(
    lingering.dependencies.verifyDeactivatedDns(lingering.plan)
  ).rejects.toThrow("still resolves after deactivation");
});

test("activation commits the receipt after mocked resolver and DNS proof", async () => {
  const f = await fixture();
  const active = await activateNativeDomainDns({
    dependencies: f.dependencies,
  });
  expect(active).toEqual(f.plan.activeReceipt);
  expect(await readFile(f.receiptPath, "utf8")).toBe(
    `${JSON.stringify(f.plan.activeReceipt)}\n`
  );
  expect(await readFile(f.plan.dnsmasqPath, "utf8")).toBe(
    f.plan.dnsmasqContent
  );
  expect(f.privilegedCalls.map((call) => call[7])).toEqual(["create"]);
});

test("config rejection rolls back only owned outputs and pending receipt", async () => {
  const f = await fixture({
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "invalid" }),
  });
  await expect(
    activateNativeDomainDns({ dependencies: f.dependencies })
  ).rejects.toMatchObject({ phase: "config-test", rollbackUncertain: false });
  await expect(readFile(f.receiptPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(f.plan.dnsmasqPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.privilegedCalls.map((call) => call[7])).toEqual([
    "create",
    "remove",
  ]);
});

test("lost resolver create reply retains the pending receipt", async () => {
  const f = await fixture({
    runPrivileged: async () => {
      throw new Error("reply lost after command dispatch");
    },
  });
  let failure: unknown;
  try {
    await activateNativeDomainDns({ dependencies: f.dependencies });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    phase: "resolver-create",
    rollbackUncertain: true,
  });
  expect((failure as { originalCause: unknown }).originalCause).toBeInstanceOf(
    NativeDnsUncertainEffectError
  );
  expect(await readFile(f.receiptPath, "utf8")).toBe(
    `${JSON.stringify(f.plan.pendingReceipt)}\n`
  );
  await expect(readFile(f.plan.dnsmasqPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("unparseable resolver create reply is uncertain", async () => {
  const f = await fixture({
    runPrivileged: async () => ({
      exitCode: 0,
      stdout: "created but reply truncated",
      stderr: "",
    }),
  });
  await expect(
    f.dependencies.createExclusive({
      path: f.plan.resolverPath,
      content: f.plan.resolverContent,
    })
  ).rejects.toBeInstanceOf(NativeDnsUncertainEffectError);
});

test("fixed privileged resolver program guards inode, content, and symlinks in an isolated directory", async () => {
  let root = "";
  const f = await fixture({
    runPrivileged: async (command) => {
      const resolverDir = join(root, "resolver");
      const script = command[6]?.replaceAll("/etc/resolver", resolverDir);
      if (!script) {
        throw new Error("Missing resolver program");
      }
      return await exec(
        ["/usr/bin/python3", "-I", "-S", "-c", script, ...command.slice(7)],
        { stdin: "ignore", timeoutMs: 3000 }
      );
    },
  });
  root = f.root;
  const expected = {
    path: f.plan.resolverPath,
    content: f.plan.resolverContent,
  };
  const owned = await f.dependencies.createExclusive(expected);
  expect(await readFile(expected.path, "utf8")).toBe(expected.content);
  await writeFile(expected.path, "foreign\n");
  expect(await f.dependencies.removeIfOwned(owned)).toBe(false);
  expect(await readFile(expected.path, "utf8")).toBe("foreign\n");

  await rm(expected.path);
  await writeFile(expected.path, expected.content);
  expect(await f.dependencies.removeIfOwned(owned)).toBe(false);
  expect(await readFile(expected.path, "utf8")).toBe(expected.content);

  await rm(expected.path);
  const ownAgain = await f.dependencies.createExclusive(expected);
  expect(await f.dependencies.removeIfOwned(ownAgain)).toBe(true);
  await expect(readFile(expected.path)).rejects.toMatchObject({
    code: "ENOENT",
  });

  const target = join(f.root, "foreign-target");
  await writeFile(target, "untouched\n");
  await symlink(target, expected.path);
  await expect(f.dependencies.createExclusive(expected)).rejects.toBeInstanceOf(
    NativeDnsUncertainEffectError
  );
  expect(await readFile(target, "utf8")).toBe("untouched\n");
  expect(await readFile(expected.path, "utf8")).toBe("untouched\n");
});

test("activated temporary claim deactivates through real file effects and commits inactive", async () => {
  let root = "";
  const runPrivileged: NativeDnsCommandRunner = async (command) => {
    const script = command[6]?.replaceAll(
      "/etc/resolver",
      join(root, "resolver")
    );
    if (!script) {
      throw new Error("Missing resolver program");
    }
    return await exec(
      ["/usr/bin/python3", "-I", "-S", "-c", script, ...command.slice(7)],
      { stdin: "ignore", timeoutMs: 3000 }
    );
  };
  const f = await fixture({ runPrivileged });
  root = f.root;
  await activateNativeDomainDns({ dependencies: f.dependencies });
  const active = planNativeDomainDns({
    domain: f.plan.domain,
    mainConfig: {
      path: join(root, "dnsmasq.conf"),
      content: `conf-dir=${join(root, "dnsmasq.d")},*.conf\n`,
    },
    includeDir: join(root, "dnsmasq.d"),
    includeFiles: [
      { path: f.plan.dnsmasqPath, content: f.plan.dnsmasqContent },
    ],
    resolverDir: join(root, "resolver"),
    resolverFiles: [
      { path: f.plan.resolverPath, content: f.plan.resolverContent },
    ],
    hosts: { path: join(root, "hosts"), content: "127.0.0.1 localhost\n" },
    dnsmasqArgs: ["dnsmasq", "-7", `${join(root, "dnsmasq.d")},*.conf`],
    receipt: f.plan.activeReceipt,
  });
  const deps = createNativeDnsHostDependencies({
    receiptPath: f.receiptPath,
    dnsmasqPath: active.dnsmasqPath,
    resolverPath: active.resolverPath,
    dnsmasqBinary: join(root, "dnsmasq"),
    dnsmasqMainConfigPath: join(root, "dnsmasq.conf"),
    dnsmasqIncludeDir: join(root, "dnsmasq.d"),
    inspectPlan: async () => ({ plan: active, fingerprint: "active-snapshot" }),
    authorize: async () => true,
    restartDnsmasq: async () => {},
    flushDnsCache: async () => {},
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runPrivileged,
  });
  const result = await deactivateNativeDomainDns({
    dependencies: deps,
    receiptPath: f.receiptPath,
  });
  expect(result).toEqual(active.inactiveReceipt);
  expect(await readFile(f.receiptPath, "utf8")).toBe(
    `${JSON.stringify(active.inactiveReceipt)}\n`
  );
  await expect(readFile(active.dnsmasqPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(active.resolverPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
