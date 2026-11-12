import { expect, test } from "bun:test";

test("native follow admission stays on the observer surface without mutation or foreground control", async () => {
  for (const file of [
    "../packages/runtime-core/src/provider/graph/log_follow.rs",
    "../packages/runtime-core/src/provider/graph/native/log_follow.rs",
  ]) {
    const source = await Bun.file(new URL(file, import.meta.url)).text();
    expect(source).toContain("Observer::connect(candidate)");
    expect(source).not.toMatch(
      /OwnedGuest|Lock::|state::write|control::|foreground::/
    );
    expect(source).toContain('error.code == "engine_not_found"');
    expect(source).toContain('initial["State"]["StartedAt"]');
  }
});

test("streaming command bypasses the serial graph command and its bounded JSON footer", async () => {
  const source = await Bun.file(
    new URL("../packages/runtime-core/src/main.rs", import.meta.url)
  ).text();
  const stream = source.indexOf('["graph", "logs-follow", arguments @ ..]');
  const bounded = source.indexOf('["graph", arguments @ ..]');
  expect(stream).toBeGreaterThan(0);
  expect(stream).toBeLessThan(bounded);
  expect(source.slice(stream, bounded)).not.toContain("print_json");
});
