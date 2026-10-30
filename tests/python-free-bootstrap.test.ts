import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBootstrap } from "../scripts/installer/bootstrap.ts";
import { hash } from "../scripts/installer/integrity.ts";

// Filesystem fixtures may span several bounded subprocesses; the suite default is only 5 s.
const fixtureTest = (name: string, run: () => void | Promise<void>) =>
  test(name, run, 30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(
  options: {
    badHash?: boolean;
    signatureFailure?: boolean;
    curlFailure?: boolean;
    redirect?: string;
    status?: string;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-bootstrap-")));
  roots.push(root);
  const bin = join(root, "path");
  const home = join(root, "home");
  const temp = join(root, "temp");
  for (const path of [bin, home, temp]) {
    mkdirSync(path, { mode: 0o700 });
  }
  for (const tool of ["shasum", "mktemp", "chmod", "rm", "cp", "date"]) {
    symlinkSync(
      `/bin/${tool === "shasum" || tool === "mktemp" ? "../usr/bin/" : ""}${tool}`,
      join(bin, tool)
    );
  }
  const script = (name: string, text: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${text}\n`, {
      mode: 0o755,
    });
  script("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac');
  const manager = join(root, "fixture-manager");
  writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$@" > "$INVOCATION"\n', {
    mode: 0o500,
  });
  script(
    "codesign",
    `printf '%s\\n' "$@" > "$SIGNATURE_ARGS"\nexit ${options.signatureFailure ? 1 : 0}`
  );
  script(
    "curl",
    `printf '%s\\n' "$@" >> "$CURL_ARGS"\n${options.curlFailure ? "exit 22" : ""}
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; output=$1; fi
  shift
done
cp "$FIXTURE_MANAGER" "$output"
printf '%s' '${options.redirect ? `302 ${options.redirect}` : `${options.status ?? "200"} `}'`
  );
  const bootstrap = join(root, "install.sh");
  writeFileSync(
    bootstrap,
    renderBootstrap(
      "5.0.0-next.9",
      options.badHash ? "0".repeat(64) : hash(readFileSync(manager))
    )
  );
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: temp,
    INVOCATION: join(root, "invocation"),
    SIGNATURE_ARGS: join(root, "signature"),
    CURL_ARGS: join(root, "curl-args"),
    FIXTURE_MANAGER: manager,
  };
  return { root, bin, home, temp, bootstrap, env };
}
for (const shell of [
  ["/bin/sh"],
  ["/bin/bash", "--posix"],
  ["/bin/zsh", "--emulate", "sh"],
]) {
  fixtureTest(
    `bootstrap works under ${shell.join(" ")} with no Python or Bun in PATH`,
    () => {
      if (!existsSync(shell[0] as string)) {
        return;
      }
      const f = fixture();
      const result = Bun.spawnSync([...shell, f.bootstrap], {
        env: f.env,
        timeout: 10_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(f.env.INVOCATION, "utf8")).toBe(
        `--root\n${f.home}/.hack-next\ninstall\n--version\n5.0.0-next.9\n`
      );
      const args = readFileSync(f.env.CURL_ARGS, "utf8");
      for (const flag of [
        "--proto\n=https",
        "--tlsv1.2",
        "--speed-limit\n1",
        "--speed-time\n30",
        "--max-filesize\n268435456",
      ]) {
        expect(args).toContain(flag);
      }
      const total = Number(args.split("--max-time\n")[1]?.split("\n")[0]);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(1800);
      expect(args).not.toContain("--insecure");
      expect(args).not.toContain("--location");
      expect(result.stdout.toString()).toContain(
        'export PATH="$HOME/.hack-next/bin:$PATH"'
      );
      expect(Bun.which("python3", { PATH: f.bin })).toBeNull();
      expect(Bun.which("bun", { PATH: f.bin })).toBeNull();
      expect(existsSync(`${f.home}/.hack-next`)).toBe(false); // Stand-in records protocol; compiled manager has a separate test.
      expect(Bun.spawnSync(["/bin/sh", "-n", f.bootstrap]).exitCode).toBe(0);
    }
  );
}
for (const [name, options, error] of [
  ["hash", { badHash: true }, "checksum mismatch"],
  ["signature", { signatureFailure: true }, "signature failed"],
  ["transport", { curlFailure: true }, "download failed"],
  [
    "foreign redirect",
    { redirect: "https://evil.invalid/payload" },
    "nonofficial",
  ],
  [
    "insecure redirect",
    { redirect: "http://github.com/payload" },
    "nonofficial",
  ],
  [
    "credential redirect",
    { redirect: "https://user@github.com/payload" },
    "nonofficial",
  ],
  ["partial status", { status: "206" }, "unexpected status"],
] as const) {
  fixtureTest(
    `bootstrap refuses ${name} without invoking manager or touching home`,
    () => {
      const f = fixture(options);
      const sentinel = join(f.home, "keep");
      writeFileSync(sentinel, "original");
      const result = Bun.spawnSync(["/bin/sh", f.bootstrap], {
        env: f.env,
        timeout: 10_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(error);
      expect(existsSync(f.env.INVOCATION)).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("original");
      expect(existsSync(join(f.home, ".hack-next"))).toBe(false);
    }
  );
}
fixtureTest(
  "bootstrap refuses relative roots and missing tools before network requests",
  () => {
    const f = fixture();
    const relative = Bun.spawnSync(
      ["/bin/sh", f.bootstrap, "--root", "relative"],
      { env: f.env, timeout: 10_000 }
    );
    expect(relative.exitCode).not.toBe(0);
    expect(relative.stderr.toString()).toContain("absolute");
    rmSync(join(f.bin, "shasum"));
    const missing = Bun.spawnSync(["/bin/sh", f.bootstrap], {
      env: f.env,
      timeout: 10_000,
    });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("Required system tool");
    expect(existsSync(f.env.CURL_ARGS)).toBe(false);
  }
);
fixtureTest(
  "bootstrap rejects invalid advanced archive pairs before any transfer",
  () => {
    for (const args of [
      ["--archive", "/fixture"],
      ["--sha256", "a".repeat(64)],
      ["--archive", "relative", "--sha256", "a".repeat(64)],
      ["--archive", "/fixture", "--sha256", "bad"],
      ["--archive", "/fixture", "--sha256", "A".repeat(64)],
      [
        "--archive",
        "/fixture",
        "--sha256",
        "a".repeat(64),
        "--sha256",
        "a".repeat(64),
      ],
      ["--root", "/one", "--root", "/two"],
      ["--archive", ""],
    ]) {
      const f = fixture();
      const result = Bun.spawnSync(["/bin/sh", f.bootstrap, ...args], {
        env: f.env,
        timeout: 10_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(f.env.CURL_ARGS)).toBe(false);
      expect(existsSync(f.env.INVOCATION)).toBe(false);
    }
  }
);
fixtureTest(
  "advanced archive pair is forwarded verbatim to the same manager contract",
  () => {
    const f = fixture();
    const checksum = "a".repeat(64);
    const result = Bun.spawnSync(
      [
        "/bin/sh",
        f.bootstrap,
        "--archive",
        "/fixture with spaces.tar.gz",
        "--sha256",
        checksum,
      ],
      { env: f.env, timeout: 10_000 }
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(f.env.INVOCATION, "utf8")).toContain(
      `--archive\n/fixture with spaces.tar.gz\n--sha256\n${checksum}\n`
    );
  }
);
