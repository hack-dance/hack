import { composeRuntimeBackend } from "../../src/backends/runtime-backend.ts";

const root = process.argv[2];
if (!root) {
  throw new Error("missing synthetic fixture root");
}
const before = process.listenerCount("SIGINT");
const code = await composeRuntimeBackend.up({
  cwd: root,
  composeFiles: ["compose.yml"],
  detach: false,
  env: { PATH: `${root}:${process.env.PATH}` },
});
await Bun.write(
  `${root}/result.json`,
  JSON.stringify({ code, before, after: process.listenerCount("SIGINT") })
);
process.exitCode = code;
