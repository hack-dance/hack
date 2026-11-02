import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STDOUT = "synthetic-private-owned-output";
const STDERR = "synthetic-private-owned-diagnostic";
const terminalProbe = `import json, os, pty, sys
root, executable, script = sys.argv[1:]
child, terminal = pty.fork()
if child == 0:
    original = os.tcgetpgrp(0)
    for descriptor, name in [(1, 'stdout'), (2, 'stderr')]:
        output = os.open(os.path.join(root, name), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        os.dup2(output, descriptor)
        os.close(output)
    os.execv(executable, [executable, script])
_, status = os.waitpid(child, 0)
os.close(terminal)
print(json.dumps({'exit': os.waitstatus_to_exitcode(status)}))
`;

for (const terminal of [false, true]) {
  for (const output of ["inherit", "stderr", "ignore"] as const) {
    test.skipIf(terminal && !Bun.which("python3"))(
      `${terminal ? "TTY" : "pipe"} output ${output} preserves exit status and private suppression`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "hack-shell-output-"));
        try {
          const script = join(root, "run.ts");
          await writeFile(
            script,
            `import {run} from ${JSON.stringify(join(import.meta.dir, "../src/lib/shell.ts"))};
const code=await run([process.execPath,'-e',${JSON.stringify(`console.log(${JSON.stringify(STDOUT)}); console.error(${JSON.stringify(STDERR)}); process.exit(7);`)}],{stdin:'ignore',stdout:${JSON.stringify(output)},stderr:${JSON.stringify(output === "ignore" ? "ignore" : "inherit")},forwardSignals:true,timeoutMs:5000});
process.exit(code);`
          );
          const child = Bun.spawn(
            terminal
              ? ["python3", "-c", terminalProbe, root, process.execPath, script]
              : [process.execPath, script],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
          );
          const [capturedOut, capturedErr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          const stdout = terminal
            ? await readFile(join(root, "stdout"), "utf8")
            : capturedOut;
          const stderr = terminal
            ? await readFile(join(root, "stderr"), "utf8")
            : capturedErr;
          expect(terminal ? JSON.parse(capturedOut).exit : code).toBe(7);
          expect(stdout).toBe(output === "inherit" ? `${STDOUT}\n` : "");
          expect(stderr).toBe(
            output === "ignore"
              ? ""
              : `${output === "stderr" ? `${STDOUT}\n` : ""}${STDERR}\n`
          );
          if (terminal) {
            expect(code).toBe(0);
            expect(capturedErr).toBe("");
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      15_000
    );
  }
}
