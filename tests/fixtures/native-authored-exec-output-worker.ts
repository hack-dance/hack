/**
 * HACK-2744 worker: writes one authored exec's captured streams to this
 * process's real stdout and stderr, which the test points at files. `command`
 * mode runs the public authored exec dispatch with an exec seam; `helper` mode
 * calls only the stream writer (no platform requirement).
 *
 * Inputs (environment): HACK_TEST_MODE, HACK_TEST_STDOUT_BASE64,
 * HACK_TEST_STDERR_BASE64, HACK_TEST_PROJECT_ROOT, HACK_TEST_NATIVE_HOME.
 */
import {
  tryNativeAuthoredCommand,
  writeNativeCommandStream,
} from "../../src/lib/native-authored-command.ts";

const stdout = Buffer.from(process.env.HACK_TEST_STDOUT_BASE64 ?? "", "base64");
const stderr = Buffer.from(process.env.HACK_TEST_STDERR_BASE64 ?? "", "base64");

if (process.env.HACK_TEST_MODE === "helper") {
  await writeNativeCommandStream(Bun.stdout, stdout);
  await writeNativeCommandStream(Bun.stderr, stderr);
  process.exitCode = 0;
} else {
  const projectRoot = process.env.HACK_TEST_PROJECT_ROOT ?? "";
  const nativeHome = process.env.HACK_TEST_NATIVE_HOME ?? "";
  const code = await tryNativeAuthoredCommand({
    selected: { kind: "native", projectRoot },
    options: {
      cwd: projectRoot,
      operation: "exec",
      service: "web",
      command: ["echo", "hello"],
    },
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: `${projectRoot}/explicit-native`,
      HACK_NATIVE_HOME: nativeHome,
    },
    exec: async () => ({
      backend: "native",
      run: "a".repeat(32),
      service: "web",
      container: "2".repeat(64),
      exitCode: 0,
      stdout,
      stderr,
      truncated: false,
    }),
    staleEnv: async () => null,
  });
  process.exitCode = code ?? 99;
}
