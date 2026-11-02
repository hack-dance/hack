import { mock, spyOn } from "bun:test";
import { exec as realExec } from "../../src/lib/shell.ts";

const [repoRoot, mode = "real"] = process.argv.slice(2);
if (!repoRoot) {
  throw new Error("Missing isolated Git fixture path");
}
const launches = spyOn(Bun, "spawn");
const delegateExec = realExec;
let injected = false;

// This module seam exists only in this disposable child. Every command executes
// real Git before a selected combined-command result is damaged for a control.
if (mode !== "real") {
  mock.module("../../src/lib/shell.ts", () => ({
    exec: async (...args: Parameters<typeof realExec>) => {
      const result = await delegateExec(...args);
      if (mode === "branch-failure") {
        if (args[0].includes("branch")) {
          injected = true;
          return { ...result, exitCode: 1, stdout: "untrusted branch\n" };
        }
        return result;
      }
      if (!args[0].includes("--sq")) {
        return result;
      }
      injected = true;
      const path = result.stdout.slice(0, result.stdout.lastIndexOf("\n"));
      switch (mode) {
        case "nonzero":
          return { ...result, exitCode: 128, stdout: "/untrusted\n'HEAD' " };
        case "no-separator":
          return { ...result, stdout: "/untrusted" };
        case "relative-path":
          return { ...result, stdout: "relative\n'HEAD' " };
        case "nul-path":
          return { ...result, stdout: "/untrusted\0path\n'HEAD' " };
        case "unquoted-ref":
          return { ...result, stdout: "/untrusted\nrefs/heads/wrong" };
        case "non-head-ref":
          return { ...result, stdout: `${path}\n'refs/tags/wrong' ` };
        case "backslash-ref":
          return { ...result, stdout: `${path}\n'refs/heads/wrong\\branch' ` };
        case "double-quote-ref":
          return { ...result, stdout: `${path}\n'refs/heads/wrong"branch' ` };
        default:
          throw new Error(`Unknown Git result control: ${mode}`);
      }
    },
  }));
}

const { resolveGitRegistrationMetadata } = await import(
  "../../src/lib/git-worktree.ts"
);
const metadata = await resolveGitRegistrationMetadata({ repoRoot });
const commands = launches.mock.calls.map(([argv]) => argv);
process.stdout.write(`${JSON.stringify({ metadata, commands, injected })}\n`);
