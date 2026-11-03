import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NativeDnsLaunchdRestartOptions,
  prepareNativeDnsLaunchdRestart,
} from "../src/lib/native-domain-dns-launchd.ts";
import { restoreEnv } from "./helpers/env.ts";

const accessKeys = [
  "HACK_HOME",
  "HACK_LAUNCHD_DISABLE",
  "HACK_LAUNCHD_ALLOW_ISOLATED_HOME",
] as const;
let savedEnv: Record<string, string | undefined> = {};
let scratch: string | undefined;
beforeEach(() => {
  savedEnv = Object.fromEntries(
    accessKeys.map((key) => [key, process.env[key]])
  );
  for (const key of accessKeys) {
    restoreEnv(key, undefined);
  }
});
afterEach(async () => {
  for (const key of accessKeys) {
    restoreEnv(key, savedEnv[key]);
  }
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

const BIN = "/opt/homebrew/opt/dnsmasq/sbin/dnsmasq";
const MAIN = "/opt/homebrew/etc/dnsmasq.conf";
const INCLUDE = "/opt/homebrew/etc/dnsmasq.d";
const ARGS = [
  BIN,
  "--keep-in-foreground",
  "-C",
  MAIN,
  "-7",
  `${INCLUDE},*.conf`,
];
const LABELS = ["sh.brew.dnsmasq", "homebrew.mxcl.dnsmasq"] as const;

function fixture(
  config: {
    readonly loaded?: readonly string[];
    readonly foreignPlist?: boolean;
    readonly foreignProcess?: boolean;
    readonly samePidThenNew?: boolean;
    readonly printFailure?: boolean;
  } = {}
) {
  const loaded = config.loaded ?? [LABELS[0]];
  let pid: number | null = 877;
  let running = true;
  let fileUid = 0;
  let failedKickstart = false;
  let kickstarts = 0;
  let postPrints = 0;
  const privilegedCalls: string[][] = [];
  const runCommand: NonNullable<
    NativeDnsLaunchdRestartOptions["runCommand"]
  > = async (command) => {
    if (command[0] === "/bin/launchctl" && command[1] === "print") {
      const label = command[2]?.slice("system/".length) ?? "";
      if (config.printFailure) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "launchctl inspection failed",
        };
      }
      if (!loaded.includes(label)) {
        return {
          exitCode: 113,
          stdout: "",
          stderr: `Could not find service "${label}" in domain for system`,
        };
      }
      if (kickstarts > 0 && config.samePidThenNew && ++postPrints >= 2) {
        pid = 878;
      }
      return {
        exitCode: 0,
        stdout: `system/${label} = {\n\tactive count = 1\n\tpath = /Library/LaunchDaemons/${label}.plist\n\ttype = LaunchDaemon\n\tstate = ${running ? "running" : "waiting"}\n\tprogram = ${BIN}\n\targuments = {\n${ARGS.map((arg) => `\t\t${arg}`).join("\n")}\n\t}\n${pid === null ? "" : `\tpid = ${pid}\n`}\tresource coalition = {\n\t\tstate = active\n\t}\n\tjob state = ${running ? "running" : "waiting"}\n}\n`,
        stderr: "",
      };
    }
    if (command[0] === "/usr/bin/plutil") {
      const label = command[5]?.split("/").at(-1)?.replace(".plist", "") ?? "";
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          Label: label,
          KeepAlive: true,
          RunAtLoad: true,
          ProgramArguments: config.foreignPlist ? ["/foreign/dnsmasq"] : ARGS,
        }),
        stderr: "",
      };
    }
    if (command[0] === "/bin/ps") {
      return {
        exitCode: 0,
        stdout: `${config.foreignProcess ? "/foreign/dnsmasq" : ARGS.join(" ")}\n`,
        stderr: "",
      };
    }
    throw new Error(`Unexpected read command: ${command.join(" ")}`);
  };
  const options: NativeDnsLaunchdRestartOptions = {
    dnsmasqBinary: BIN,
    mainConfigPath: MAIN,
    includeDir: INCLUDE,
    inspectedArgs: ARGS,
    runCommand,
    runPrivileged: async (command) => {
      privilegedCalls.push([...command]);
      kickstarts += 1;
      if (failedKickstart && kickstarts === 1) {
        pid = null;
        running = false;
        return { exitCode: 1, stdout: "", stderr: "kickstart failed" };
      }
      running = true;
      pid = config.samePidThenNew ? 877 : 878;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    statPath: async (path) => {
      if (path === "/Library/LaunchDaemons") {
        return {
          uid: 0,
          mode: 0o755,
          nlink: 2,
          isFile: false,
          isDirectory: true,
        };
      }
      return {
        uid: fileUid,
        mode: 0o644,
        nlink: 1,
        isFile: true,
        isDirectory: false,
      };
    },
  };
  return {
    options,
    privilegedCalls,
    setFileUid: (uid: number) => {
      fileUid = uid;
    },
    failFirstKickstart: () => {
      failedKickstart = true;
    },
  };
}

for (const label of LABELS) {
  test(`preflight selects ${label} and restarts only its validated system job`, async () => {
    const f = fixture({ loaded: [label] });
    const restart = await prepareNativeDnsLaunchdRestart(f.options);
    expect(f.privilegedCalls).toHaveLength(0);
    await restart();
    expect(f.privilegedCalls).toEqual([
      ["sudo", "-n", "/bin/launchctl", "kickstart", "-k", `system/${label}`],
    ]);
  });
}

test("preflight refuses missing, ambiguous, foreign, and unreadable jobs", async () => {
  for (const config of [
    { loaded: [] },
    { loaded: LABELS },
    { foreignPlist: true },
    { foreignProcess: true },
    { printFailure: true },
  ]) {
    const f = fixture(config);
    await expect(prepareNativeDnsLaunchdRestart(f.options)).rejects.toThrow();
    expect(f.privilegedCalls).toHaveLength(0);
  }
});

test("recheck refuses changed plist ownership before privileged effect", async () => {
  const f = fixture();
  const restart = await prepareNativeDnsLaunchdRestart(f.options);
  f.setFileUid(501);
  await expect(restart()).rejects.toThrow("root-owned");
  expect(f.privilegedCalls).toHaveLength(0);
});

test("kickstart waits through a stale PID until the new process is running", async () => {
  const f = fixture({ samePidThenNew: true });
  const restart = await prepareNativeDnsLaunchdRestart(f.options);
  await restart();
  expect(f.privilegedCalls).toHaveLength(1);
});

test("failed kickstart reports the error and permits rollback retry of the same stopped job", async () => {
  const f = fixture();
  f.failFirstKickstart();
  const restart = await prepareNativeDnsLaunchdRestart(f.options);
  await expect(restart()).rejects.toThrow("kickstart failed");
  await restart();
  expect(f.privilegedCalls).toHaveLength(2);
});

for (const accessCase of [
  "isolated",
  "disabled",
  "default",
  "opt-in",
] as const) {
  test(`recording launchctl stub: native DNS ${accessCase}`, async () => {
    scratch = await mkdtemp(join(tmpdir(), "hack-dns-launchd-"));
    const stub = join(scratch, "launchctl");
    const log = join(scratch, "calls");
    await writeFile(
      stub,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HACK_TEST_CALL_LOG"\n'
    );
    await chmod(stub, 0o755);
    const f = fixture();
    const wrap =
      (runner: NonNullable<NativeDnsLaunchdRestartOptions["runCommand"]>) =>
      async (command: readonly string[]) => {
        const offset = command[0] === "sudo" ? 3 : 1;
        if (command[offset - 1] === "/bin/launchctl") {
          const child = Bun.spawn([stub, ...command.slice(offset)], {
            env: { HACK_TEST_CALL_LOG: log },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(await child.exited).toBe(0);
        }
        return await runner(command);
      };
    const { runCommand, runPrivileged } = f.options;
    if (!(runCommand && runPrivileged)) {
      throw new Error("Fixture requires both command recorders");
    }
    const options = {
      ...f.options,
      runCommand: wrap(runCommand),
      runPrivileged: wrap(runPrivileged),
    };
    if (accessCase !== "default") {
      process.env.HACK_HOME = scratch;
    }
    if (accessCase === "opt-in" || accessCase === "disabled") {
      process.env.HACK_LAUNCHD_ALLOW_ISOLATED_HOME = "1";
    }
    if (accessCase === "disabled") {
      process.env.HACK_LAUNCHD_DISABLE = "1";
    }
    const allowed = accessCase === "default" || accessCase === "opt-in";
    if (allowed) {
      const restart = await prepareNativeDnsLaunchdRestart(options);
      await restart();
    } else {
      await expect(prepareNativeDnsLaunchdRestart(options)).rejects.toThrow(
        "launchd management is disabled"
      );
    }
    const calls = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    if (allowed) {
      expect(calls.filter((call) => call.startsWith("print "))).toHaveLength(6);
      expect(calls.filter((call) => call.startsWith("kickstart "))).toEqual([
        `kickstart -k system/${LABELS[0]}`,
      ]);
    } else {
      expect(calls).toEqual([]);
      expect(f.privilegedCalls).toEqual([]);
    }
  });
}

test("restart rechecks launchd admission after preflight", async () => {
  const f = fixture();
  const restart = await prepareNativeDnsLaunchdRestart(f.options);
  process.env.HACK_LAUNCHD_DISABLE = "1";
  await expect(restart()).rejects.toThrow("launchd management is disabled");
  expect(f.privilegedCalls).toEqual([]);
});
