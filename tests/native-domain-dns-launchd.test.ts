import { expect, test } from "bun:test";
import {
  type NativeDnsLaunchdRestartOptions,
  prepareNativeDnsLaunchdRestart,
} from "../src/lib/native-domain-dns-launchd.ts";

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
