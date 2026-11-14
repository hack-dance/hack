import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(
  opts: {
    crate?: "runtime-core" | "config-compiler";
    nextest?: boolean;
    platform?: string;
    fail?: string;
    version?: string;
    pathVersion?: string;
    repeats?: string;
    required?: boolean;
    report?: boolean;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "hack-rust-runner-"));
  roots.push(root);
  const tools = join(root, "bin");
  await mkdir(tools);
  await mkdir(join(root, "scripts"));
  for (const file of [
    "test-runtime-core.sh",
    "test-rust.sh",
    "install-cargo-nextest.sh",
  ]) {
    await copyFile(resolve("scripts", file), join(root, "scripts", file));
  }
  const log = join(root, "commands");
  const versionChild = Bun.spawn(
    [
      "/bin/bash",
      join(root, "scripts/install-cargo-nextest.sh"),
      "--print-version",
    ],
    {
      env: privateCliEnv({ root }),
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    }
  );
  const version = (await new Response(versionChild.stdout).text()).trim();
  expect(await versionChild.exited).toBe(0);
  await writeFile(
    join(tools, "cargo"),
    `#!/bin/sh\nif [ "$1:$2" = nextest:--version ]; then [ "$FIXTURE_NEXTEST" = present ] || exit 101; printf 'cargo-nextest %s\\n' "$FIXTURE_CARGO_VERSION"; exit 0; fi\nprintf '%s\\n' "$*" >> "$FIXTURE_LOG"\nprintf '%s' "$RUST_TEST_THREADS" > "$FIXTURE_THREADS"\ncase "$1:$2:$FIXTURE_FAIL" in nextest:run:nextest) exit 77;; test:--doc:doc) exit 78;; esac\nif [ "$1:$2" = nextest:run ] && [ -n "$FIXTURE_REPORT" ]; then mkdir -p "$(dirname "$FIXTURE_REPORT")"; printf '<testsuites/>\\n' > "$FIXTURE_REPORT"; fi\n`,
    { mode: 0o700 }
  );
  if (opts.nextest !== false) {
    await writeFile(
      join(tools, "cargo-nextest"),
      `#!/bin/sh\nprintf 'direct PATH lookup' > "$FIXTURE_DIRECT_LOOKUP"\nprintf '%s\\n' 'cargo-nextest ${opts.pathVersion ?? opts.version ?? version}'\n`,
      { mode: 0o700 }
    );
  }
  await writeFile(
    join(tools, "uname"),
    `#!/bin/sh\nprintf '%s\\n' '${opts.platform ?? "Linux"}'\n`,
    { mode: 0o700 }
  );
  const env = privateCliEnv({
    root,
    env: {
      PATH: `${tools}:/usr/bin:/bin`,
      FIXTURE_LOG: log,
      FIXTURE_THREADS: join(root, "threads"),
      FIXTURE_NEXTEST: opts.nextest === false ? "absent" : "present",
      FIXTURE_CARGO_VERSION: opts.version ?? version,
      FIXTURE_DIRECT_LOOKUP: join(root, "direct-lookup"),
      FIXTURE_REPORT: opts.report
        ? join(
            root,
            `packages/${opts.crate ?? "runtime-core"}/target/nextest/ci/junit.xml`
          )
        : undefined,
      FIXTURE_FAIL: opts.fail,
      HACK_RUST_TEST_RUNNER: opts.required ? "nextest" : "auto",
      HACK_RUST_TEST_REPETITIONS: opts.repeats ?? "1",
      HACK_RUST_TEST_TARGET_DIR: join(root, "target"),
      HACK_RUST_TEST_REPORT_DIR: opts.report
        ? join(root, "reports")
        : undefined,
    },
  });
  const run = async (args: string[] = []) => {
    const child = Bun.spawn(
      [
        "/bin/bash",
        join(
          root,
          opts.crate ? "scripts/test-rust.sh" : "scripts/test-runtime-core.sh"
        ),
        ...(opts.crate ? [`--crate=${opts.crate}`] : []),
        ...args,
      ],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const commands = await readFile(log, "utf8").catch(() => "");
    return {
      code,
      stdout,
      stderr,
      commands: commands.trim() ? commands.trim().split("\n") : [],
      version,
      threads: await readFile(join(root, "threads"), "utf8").catch(() => ""),
    };
  };
  return { run, root, env };
}

test("process runner executes nextest with zero retries then retains doctests for feature selection", async () => {
  const f = await fixture();
  const r = await f.run(["--all-features"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.commands).toHaveLength(2);
  expect(r.commands[0]).toContain("nextest run");
  expect(r.commands[0]).toContain("--retries 0");
  expect(r.commands[0]).toContain("--build-jobs 2");
  expect(r.commands[1]).toContain("test --doc");
  for (const command of r.commands) {
    expect(command).toContain("--all-features");
  }
});
test("explicit targets run only the selected nextest suite without conflicting doctest selectors", async () => {
  for (const args of [
    ["--lib"],
    ["--bins"],
    ["--bin", "hack-native"],
    ["--bin=hack-native"],
    ["--tests"],
    ["--test", "stream_relay_contract", "--all-features"],
    ["--test=stream_relay_contract", "--all-features"],
    ["--examples"],
    ["--example", "fixture"],
    ["--example=fixture"],
    ["--benches"],
    ["--bench", "fixture"],
    ["--bench=fixture"],
    ["--all-targets"],
  ]) {
    const r = await (await fixture()).run(args);
    expect(r.code, r.stderr).toBe(0);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toStartWith("nextest run");
    for (const argument of args) {
      expect(r.commands[0]).toContain(argument);
    }
  }
});
test("explicit documentation selection stays with Cargo and never invokes nextest", async () => {
  const r = await (await fixture()).run(["--doc", "--all-features"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.commands).toHaveLength(1);
  expect(r.commands[0]).toStartWith("test --locked");
  expect(r.commands[0]).toContain("--doc --all-features");
});
test("documentation-only selection cannot claim qualification repetitions or nextest reports", async () => {
  for (const opts of [{ repeats: "20" }, { report: true }]) {
    const r = await (await fixture(opts)).run(["--doc"]);
    expect(r.code).toBe(2);
    expect(r.commands).toEqual([]);
    expect(r.stderr).toContain("cannot produce nextest qualification evidence");
  }
});
test("arguments after the separator cannot suppress the separate doctest step", async () => {
  const r = await (await fixture()).run(["--", "--lib"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.commands).toHaveLength(2);
  expect(r.commands[0]).toStartWith("nextest run");
  expect(r.commands[1]).toStartWith("test --doc");
  for (const command of r.commands) {
    expect(command).toEndWith("-- --lib");
  }
});
for (const fail of ["nextest", "doc"]) {
  test(`20-pass qualification stops at first ${fail} failure without retry or fallback`, async () => {
    const r = await (await fixture({ fail, repeats: "20" })).run();
    expect(r.code).toBe(fail === "nextest" ? 77 : 78);
    expect(r.commands).toHaveLength(fail === "nextest" ? 1 : 2);
  });
}
test("20-pass qualification performs exactly 20 suites and 20 separate doctest steps", async () => {
  const r = await (await fixture({ repeats: "20" })).run();
  expect(r.code).toBe(0);
  expect(r.commands).toHaveLength(40);
  expect(r.commands.filter((c) => c.startsWith("nextest run"))).toHaveLength(
    20
  );
  expect(r.commands.filter((c) => c.startsWith("test --doc"))).toHaveLength(20);
});
for (const platform of ["Linux", "Darwin"]) {
  test(`missing nextest retains the cargo test fallback on ${platform}`, async () => {
    const r = await (await fixture({ nextest: false, platform })).run([
      "client_relay",
    ]);
    expect(r.code).toBe(0);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toStartWith("test --locked");
    expect(r.commands[0]).toContain("client_relay");
    expect(r.stderr.trim()).toBe(
      `cargo nextest ${r.version} unavailable; using cargo test. Optional install: cargo install --locked --version ${r.version} cargo-nextest`
    );
    expect(r.threads).toBe(platform === "Darwin" ? "1" : "");
  });
}
test("CI never degrades to libtest when the pinned process runner is missing or mismatched", async () => {
  for (const opts of [
    { nextest: false, required: true },
    { version: "0.9.150", required: true },
    { version: "0.9.1512", required: true },
    { version: "0.9.150", repeats: "20" },
    { version: "0.9.150", report: true },
  ]) {
    const r = await (await fixture(opts)).run();
    expect(r.code).toBe(2);
    expect(r.commands).toEqual([]);
    expect(r.stderr).toContain("cargo install --locked --version");
  }
});
test("another contributor nextest version falls back without replacing it on either host", async () => {
  for (const platform of ["Linux", "Darwin"]) {
    const r = await (await fixture({ version: "0.9.150", platform })).run([
      "--lib",
      "--all-features",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toStartWith("test --locked");
    expect(r.commands[0]).toEndWith("--lib --all-features");
    expect(r.stderr.trim()).toBe(
      `cargo nextest ${r.version} unavailable; using cargo test. Optional install: cargo install --locked --version ${r.version} cargo-nextest`
    );
    expect(r.threads).toBe(platform === "Darwin" ? "1" : "");
  }
});
test("the version check follows Cargo subcommand resolution instead of the PATH binary", async () => {
  const rightCargo = await fixture({
    pathVersion: "0.9.150",
    required: true,
  });
  const accepted = await rightCargo.run();
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(accepted.commands[0]).toStartWith("nextest run");
  const wrongCargo = await fixture({
    version: "0.9.150",
    pathVersion: accepted.version,
    required: true,
  });
  const refused = await wrongCargo.run();
  expect(refused.code).toBe(2);
  expect(refused.commands).toEqual([]);
  for (const f of [wrongCargo, rightCargo]) {
    expect(await Bun.file(join(f.root, "direct-lookup")).exists()).toBe(false);
  }
});

test("per-pass evidence is read from the Cargo workspace store even with a separate target directory", async () => {
  const f = await fixture({ report: true });
  const r = await f.run();
  expect(r.code, r.stderr).toBe(0);
  expect(await readFile(join(f.root, "reports/default-1.xml"), "utf8")).toBe(
    "<testsuites/>\n"
  );
  expect(r.commands.some((command) => command.startsWith("nextest list"))).toBe(
    true
  );
  expect(
    r.commands.some((command) =>
      command.startsWith("nextest show-config test-groups")
    )
  ).toBe(true);
});

test("a failed nextest invocation cannot publish the previous pass's stale JUnit as fresh evidence", async () => {
  const f = await fixture({ report: true, fail: "nextest" });
  const store = join(f.root, "packages/runtime-core/target/nextest/ci");
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "junit.xml"), "stale success");
  const r = await f.run();
  expect(r.code).toBe(77);
  expect(await Bun.file(join(f.root, "reports/default-1.xml")).exists()).toBe(
    false
  );
  expect(
    r.commands.filter((command) => command.startsWith("nextest run"))
  ).toHaveLength(1);
  expect(r.commands.some((command) => command.startsWith("test --doc"))).toBe(
    false
  );
});

test("the pinned installer refuses corrupt download bytes before extraction or execution", async () => {
  const f = await fixture();
  const tools = join(f.root, "bin");
  await writeFile(
    join(tools, "uname"),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n',
    { mode: 0o700 }
  );
  await writeFile(
    join(tools, "curl"),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf \'corrupt fixture archive\' > "$1"; exit 0; fi; shift; done\nexit 2\n',
    { mode: 0o700 }
  );
  const extracted = join(f.root, "extracted");
  await writeFile(
    join(tools, "tar"),
    "#!/bin/sh\nprintf 'unexpected extraction' > \"$FIXTURE_EXTRACTED\"\nexit 88\n",
    { mode: 0o700 }
  );
  const child = Bun.spawn(
    [
      "/bin/bash",
      join(f.root, "scripts/install-cargo-nextest.sh"),
      join(f.root, "install"),
    ],
    {
      env: { ...f.env, FIXTURE_EXTRACTED: extracted },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).not.toBe(0);
  expect(`${stdout}${stderr}`).toContain("FAILED");
  expect(await Bun.file(extracted).exists()).toBe(false);
});

for (const platform of ["Linux", "Darwin"]) {
  test(`compiler uses process isolation and its own report store on ${platform}`, async () => {
    const f = await fixture({
      crate: "config-compiler",
      platform,
      report: true,
      required: true,
    });
    const r = await f.run();
    expect(r.code, r.stderr).toBe(0);
    for (const command of r.commands) {
      expect(command).toContain(
        "--manifest-path packages/config-compiler/Cargo.toml"
      );
      expect(command).not.toContain("packages/runtime-core");
    }
    expect(r.commands.filter((c) => c.startsWith("nextest run"))).toHaveLength(
      1
    );
    expect(r.commands.filter((c) => c.startsWith("test --doc"))).toHaveLength(
      1
    );
    expect(await Bun.file(join(f.root, "reports/default-1.xml")).text()).toBe(
      "<testsuites/>\n"
    );
  });
}
