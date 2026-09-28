import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateNativeDomainDns,
  NativeDnsUncertainEffectError,
} from "../src/lib/native-domain-dns-activate.ts";
import {
  createNativeDnsHostDependencies,
  type NativeDnsCommandRunner,
} from "../src/lib/native-domain-dns-host.ts";
import { planNativeDomainDns } from "../src/lib/native-domain-dns-plan.ts";

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
