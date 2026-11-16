import { expect, test } from "bun:test";
import { parseLaunchdPrintJob } from "../src/daemon/launchd-print.ts";

/*
 * HACK-2216: what launchd has LOADED for hackd, read from `launchctl print
 * gui/<uid>/dance.hack.hackd`. A kickstart runs this configuration, which
 * can differ from the plist on disk until the job is reloaded.
 */

/** Output in the shape `launchctl print` uses on macOS (tabs, nesting). */
const REAL_LOOKING = [
  "gui/501/dance.hack.hackd = {",
  "\tactive count = 1",
  "\tpath = /Users/example/Library/LaunchAgents/dance.hack.hackd.plist",
  "\ttype = LaunchAgent",
  "\tstate = running",
  "",
  "\tprogram = /usr/local/bin/hack",
  "\targuments = {",
  "\t\t/usr/local/bin/hack",
  "\t\tdaemon",
  "\t\tstart",
  "\t\t--foreground",
  "\t}",
  "",
  "\tworking directory = /Users/example",
  "",
  "\tstdout path = /dev/null",
  "\tstderr path = /dev/null",
  "\tinherited environment = {",
  "\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.example/Listeners",
  "\t\tPATH => /srv/inherited/bin",
  "\t}",
  "",
  "\tdefault environment = {",
  "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin",
  "\t}",
  "",
  "\tenvironment = {",
  "\t\tHOME => /Users/example",
  "\t\tPATH => /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  "\t\tXPC_SERVICE_NAME => dance.hack.hackd",
  "\t}",
  "",
  "\tdomain = gui/501 [100005]",
  "\tasid = 100005",
  "\tminimum runtime = 10",
  "\texit timeout = 5",
  "\truns = 3",
  "\tpid = 4242",
  "\timmediate reason = speculative",
  "\tforks = 0",
  "\texecs = 1",
  "\tlast exit code = 0",
  "",
  "\tevent triggers = {",
  '\t\t"com.apple.example" => {',
  "\t\t\tstate = 0",
  "\t\t}",
  "\t}",
  "",
  "\tproperties = keepalive | runatload | inferred program",
  "}",
  "",
].join("\n");

test("reads the program, arguments and the job's own PATH from launchctl print", () => {
  expect(parseLaunchdPrintJob(REAL_LOOKING)).toEqual({
    kind: "job",
    program: "/usr/local/bin/hack",
    arguments: ["/usr/local/bin/hack", "daemon", "start", "--foreground"],
    // The job's environment, not the inherited or default one.
    path: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  });
});

test("a job without its own PATH reports none; the program falls back to the first argument", () => {
  const noPath = REAL_LOOKING.replace(
    "\t\tPATH => /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin\n",
    ""
  ).replace("\tprogram = /usr/local/bin/hack\n", "");
  expect(parseLaunchdPrintJob(noPath)).toMatchObject({
    kind: "job",
    program: "/usr/local/bin/hack",
    path: null,
  });
});

test("anything that is not exactly one well-formed service block is unknown", () => {
  const cases = [
    "",
    "Bad request.\nCould not find service",
    // Not closed.
    REAL_LOOKING.replace(/\}\n$/, ""),
    // Content after the service block.
    `${REAL_LOOKING}gui/501/other = {\n}\n`,
    // A repeated PATH.
    REAL_LOOKING.replace(
      "\t\tXPC_SERVICE_NAME",
      "\t\tPATH => /srv/shared/bin\n\t\tXPC_SERVICE_NAME"
    ),
    // A second environment block.
    REAL_LOOKING.replace(
      "\tdomain = gui/501",
      "\tenvironment = {\n\t\tPATH => /srv/shared/bin\n\t}\n\tdomain = gui/501"
    ),
    // A second program.
    REAL_LOOKING.replace(
      "\tworking directory",
      "\tprogram = /srv/other/hack\n\tworking directory"
    ),
    // An environment entry that is not `KEY => value`.
    REAL_LOOKING.replace("\t\tHOME => /Users/example", "\t\tHOME"),
    // No arguments.
    REAL_LOOKING.replace(
      /\targuments = \{\n(\t\t[^\n]*\n)+\t\}\n/,
      "\targuments = {\n\t}\n"
    ),
    // A relative program.
    REAL_LOOKING.replace("\tprogram = /usr/local/bin/hack", "\tprogram = hack"),
  ];
  for (const output of cases) {
    expect(parseLaunchdPrintJob(output).kind).toBe("unknown");
  }
});
