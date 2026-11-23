import { expect, test } from "bun:test";
import { nativeHomeProcesses } from "../src/backends/native-home-processes.ts";

const home = "/fixture/versions/one/native-home";

/** A scripted ps and lsof: `ps` rows, then lsof `-Fpn` rows. */
function listings(ps: string, lsof: string, codes = { ps: 0, lsof: 0 }) {
  return (argv: readonly string[]) =>
    Promise.resolve(
      argv[0] === "/bin/ps"
        ? { code: codes.ps, stdout: ps }
        : { code: codes.lsof, stdout: lsof }
    );
}

test("processes naming the home or working inside it are found; prefixes and the scanner are not", async () => {
  const found = await nativeHomeProcesses(home, {
    self: 99,
    run: listings(
      [
        `  101 /opt/hack/hack-native --candidate-root ${home} graph serve`,
        `  102 /opt/hack/hack-cli --internal-native-https-owner ${home}/native-https/shared-owner/configuration.json`,
        `  103 /opt/hack/hack-native --candidate-root ${home}-two graph serve`,
        "  104 /usr/bin/editor notes.txt",
        `   99 hack doctor --native-run-mapping release (scanner, names ${home})`,
      ].join("\n"),
      [
        "p104",
        "fcwd",
        `n${home}/logs`,
        "p105",
        "fcwd",
        "n/tmp",
        "p99",
        "fcwd",
        "n/project",
      ].join("\n")
    ),
  });
  expect(found).toEqual([
    { pid: 101, why: "command" },
    { pid: 102, why: "command" },
    { pid: 104, why: "cwd" },
  ]);
});

test("an unreadable or unparsable listing refuses instead of reading as empty", async () => {
  const self = "  99 hack doctor";
  for (const run of [
    listings("", ""),
    listings("garbage row", ""),
    listings(`${self}\n  1 /sbin/launchd`, "p99\nfcwd\nn/", { ps: 1, lsof: 0 }),
    listings(`${self}\n  1 /sbin/launchd`, "p99\nfcwd\nn/", { ps: 0, lsof: 2 }),
    // A failed lsof run also exits 1: with no output it must not read as empty.
    listings(`${self}\n  1 /sbin/launchd`, "", { ps: 0, lsof: 1 }),
    // A listing that does not show this very process did not really run.
    listings("  1 /sbin/launchd", "p99\nfcwd\nn/"),
    listings(self, "p1\nfcwd\nn/"),
  ]) {
    await expect(nativeHomeProcesses(home, { self: 99, run })).rejects.toThrow(
      "cannot be proven gone"
    );
  }
  // lsof's exit 1 (some process unreadable) still counts its readable rows.
  expect(
    await nativeHomeProcesses(home, {
      self: 99,
      run: listings(
        `${self}\n  1 /sbin/launchd`,
        "p99\nfcwd\nn/\np1\nfcwd\nn/",
        {
          ps: 0,
          lsof: 1,
        }
      ),
    })
  ).toEqual([]);
});
