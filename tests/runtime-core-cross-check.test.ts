import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

/** Run a wrapper against a fake `zig` that records its arguments, NUL-separated. */
async function argumentsPassedToZig(
  wrapper: string,
  input: readonly string[]
): Promise<string[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zig-cross-")));
  try {
    const capture = join(root, "arguments");
    await writeFile(
      join(root, "zig"),
      '#!/bin/sh\nset -eu\nprintf \'%s\\000\' "$@" > "$ZIG_ARGUMENTS"\n',
      { mode: 0o700 }
    );
    const child = Bun.spawn(
      ["/bin/sh", resolve(repoRoot, "scripts", wrapper), ...input],
      {
        env: { PATH: root, ZIG_ARGUMENTS: capture },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    expect(await child.exited).toBe(0);
    return (await readFile(capture, "utf8")).split("\0").slice(0, -1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("macOS C compiler wrapper for non-Mac hosts", () => {
  test("cc-rs Rust and clang targets give way to the fixed Zig target", async () => {
    expect(
      await argumentsPassedToZig("zig-aarch64-macos-cc", [
        "-O0",
        "--target=arm64-apple-macosx",
        "--target=arm64-apple-macosx11.0",
        "--target=aarch64-apple-darwin",
        "-mmacosx-version-min=11.0",
        "-arch",
        "arm64",
        "-c",
        "source file.c",
      ])
    ).toEqual([
      "cc",
      "-target",
      "aarch64-macos",
      "-O0",
      "-mmacosx-version-min=11.0",
      "-arch",
      "arm64",
      "-c",
      "source file.c",
    ]);
  });

  test("other targets and arguments keep their exact order and bytes", async () => {
    const input = [
      "--target=x86_64-apple-macosx",
      "--target=arm64-apple-ios",
      "literal $(not-a-command)",
      "",
    ];
    expect(await argumentsPassedToZig("zig-aarch64-macos-cc", input)).toEqual([
      "cc",
      "-target",
      "aarch64-macos",
      ...input,
    ]);
  });

  test("the archiver forwards every argument to zig ar", async () => {
    expect(
      await argumentsPassedToZig("zig-ar", ["crs", "lib a.a", "a.o"])
    ).toEqual(["ar", "crs", "lib a.a", "a.o"]);
  });
});

type Step = {
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
};
type Workflow = {
  readonly jobs: Record<
    string,
    { readonly if?: string; readonly steps?: readonly Step[] }
  >;
};

describe("PR cross-lint of runtime-core (HACK-2474)", () => {
  test("the Linux candidate leg lints the macOS and musl targets", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text()
    ) as Workflow;
    const job = workflow.jobs["runtime-core"];
    // Ready PRs run only the ubuntu leg of this job; it follows runtime-core inputs.
    expect(job?.if).toContain("needs.changes.outputs.runtime_core == 'true'");
    const step = job?.steps?.find((entry) => entry.id === "lint-cross");
    expect(step?.if).toContain("runner.os == 'Linux'");
    expect(step?.run).toContain(
      "rustup target add aarch64-apple-darwin aarch64-unknown-linux-musl"
    );
    expect(step?.run).toContain("sh scripts/check-runtime-core-cross.sh");
  });

  test("the script lints every shipped non-host target with warnings denied", async () => {
    const script = await readFile(
      resolve(repoRoot, "scripts/check-runtime-core-cross.sh"),
      "utf8"
    );
    expect(script).toContain('for features in "" --all-features; do');
    expect(script).toContain(
      "--target aarch64-apple-darwin --all-targets $features --jobs 2 -- -D warnings"
    );
    expect(script).toContain(
      "--target aarch64-unknown-linux-musl --bin hack-storage-root-witness"
    );
    expect(script).toContain("--features storage-root-witness-tool");
    expect(script).toContain(
      'CC_aarch64_apple_darwin="$repo/scripts/zig-aarch64-macos-cc"'
    );
  });
});
