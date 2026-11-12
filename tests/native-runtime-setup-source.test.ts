import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import pins from "../packages/runtime-core/provider-pins.json";

const runtime = "packages/runtime-core/src";

test("setup acquisition stays behind the explicit native command", async () => {
  const main = await Bun.file(join(runtime, "main.rs")).text();
  const up = await Bun.file(join(runtime, "runtime_up_cli.rs")).text();
  const cli = await Bun.file(join(runtime, "runtime_setup_cli.rs")).text();
  expect(main).toContain('["runtime", "setup", arguments @ ..]');
  expect(main).toContain("runtime_setup_cli::run(");
  expect(up).not.toContain("setup::");
  expect(cli).toContain("E_INTERACTIVE_REQUIRED");
  // New entrypoints must not silently acquire providers from up/probe/lifecycle.
  for (const file of await readdir(runtime)) {
    if (!file.endsWith(".rs") || file === "runtime_setup_cli.rs") {
      continue;
    }
    expect(await Bun.file(join(runtime, file)).text()).not.toContain(
      "setup::run("
    );
  }
});

test("download manifest and user docs retain the manual trust pins", async () => {
  const artifact = await Bun.file(join(runtime, "provider/artifact.rs")).text();
  const guest = await Bun.file(
    join(runtime, "provider/network_tools.rs")
  ).text();
  const guide = await Bun.file("docs/guides/native-candidate.md").text();
  const tryIt = await Bun.file("docs/native/try-it.md").text();
  for (const pin of [pins.smolvm, pins.docker, ...pins.network_tools]) {
    expect(pin.url).toStartWith("https://");
    expect(pin.archive_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pin.max_bytes).toBeGreaterThan(0);
    expect(pin.max_bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(pin.size_bytes).toBeGreaterThan(0);
    expect(pin.size_bytes).toBeLessThanOrEqual(pin.max_bytes);
    expect(`${artifact}\n${guest}`).toContain(pin.archive_sha256);
  }
  for (const page of [guide, tryIt]) {
    expect(page).toContain("runtime setup");
    expect(page).toContain("--accept-downloads");
    expect(page).toContain("runtime prepare --archive");
    expect(page).toContain("runtime prepare-engine --archive");
    expect(page).toContain("runtime prepare-network-tools --directory");
  }
  expect(await Bun.file("docs/native/limits.md").text()).not.toContain(
    "A one-command setup"
  );
});
