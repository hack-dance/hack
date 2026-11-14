import {
  nativeInteractiveExec,
  nativeInteractiveRequested,
} from "../../src/backends/native-interactive-exec.ts";

const [root, mode] = process.argv.slice(2);
if (!(root && mode)) {
  throw new Error("fixture arguments");
}
if (mode.startsWith("selection-")) {
  await Bun.write(
    `${root}/selection.json`,
    JSON.stringify(nativeInteractiveRequested())
  );
  process.exit(0);
}
process.exitCode = await nativeInteractiveExec({
  runtime: { binary: `${root}/runtime`, home: root },
  projectRoot: root,
  branch: "topic",
  run: "a".repeat(32),
  owner: "b".repeat(32),
  plan: "c".repeat(64),
  namespace: "d".repeat(64),
  service: "web",
  command: [mode],
  native: false,
  payload: new TextEncoder().encode("synthetic-private-envelope-canary"),
});
