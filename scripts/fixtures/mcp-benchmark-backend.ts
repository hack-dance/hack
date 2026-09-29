/** Measurement-only entrypoint: records process identity and exit status without
 * adding a resident wrapper. Never use this binary in installed client settings.
 */
import { constants, lstatSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const directory = process.env.HACK_MCP_LEASE_DIRECTORY;
if (!(directory && isAbsolute(directory))) {
  throw new Error("Benchmark backend requires a native ownership directory");
}
const stat = lstatSync(directory);
if (
  !stat.isDirectory() ||
  stat.uid !== process.getuid?.() ||
  (stat.mode & 0o077) !== 0
) {
  throw new Error("Benchmark ownership directory must be private");
}
const options = {
  mode: 0o600,
  flag:
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW,
};
writeFileSync(
  join(directory, "benchmark-process.json"),
  JSON.stringify({ pid: process.pid, supervisor: process.ppid }),
  options
);
process.once("exit", (code) => {
  writeFileSync(
    join(directory, "benchmark-exit.json"),
    JSON.stringify({ pid: process.pid, code }),
    options
  );
});
// Only post-disconnect retention differs from the production entrypoint.
if (Bun.argv.slice(2).length !== 4) {
  throw new Error("Unexpected benchmark backend arguments");
}
Bun.argv.push("1000");
await import("../run-mcp-socket-backend.ts");
