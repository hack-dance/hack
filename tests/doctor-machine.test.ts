import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "../index.ts");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doctor-machine-"));
  const project = join(root, "project");
  const tools = join(root, "tools");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(tools);
  // Ordinary discovery must refuse this native input. Machine audit must never read it.
  await Bun.write(
    join(project, ".hack/hack.project.json"),
    "{invalid PROJECT_CANARY"
  );
  await Bun.write(
    join(project, ".hack/hack.config.json"),
    "{invalid PROJECT_CANARY"
  );
  const calls = join(root, "calls");
  const forbidden = join(root, "forbidden");
  for (const name of [
    "docker",
    "hackd",
    "sudo",
    "security",
    "systemctl",
    "git",
    "native-runtime",
  ]) {
    await Bun.write(
      join(tools, name),
      `#!${process.execPath}\nconst args=process.argv.slice(2);\nawait Bun.write(${JSON.stringify(calls)}, (await Bun.file(${JSON.stringify(calls)}).text().catch(()=>""))+${JSON.stringify(name)}+" "+args.join(" ")+"\\n");\nconst allowed=${JSON.stringify(name)} === "docker" && (["info","ps","inspect","version"].includes(args[0]) || args[0] === "network" && args[1] === "inspect");\nconst readOnlyService=${JSON.stringify(name)} === "systemctl" && args.join(" ") === "is-active systemd-resolved";\nif(!(allowed || readOnlyService)) await Bun.write(${JSON.stringify(forbidden)},"unexpected-effect");\nprocess.exit(1);\n`
    );
    await chmod(join(tools, name), 0o700);
  }
  const invoke = async (flags: string[], native = false) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", cli, "doctor", ...flags],
      {
        cwd: project,
        env: privateCliEnv({
          root,
          env: {
            HACK_HOME: join(root, "state"),
            HACK_GLOBAL_CONFIG_PATH: join(root, "state/hack.config.json"),
            PATH: `${tools}:/usr/bin:/bin`,
            HACK_NO_INTERACTIVE: "1",
            HACK_LOGGER: "console",
            HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
            ...(native
              ? {
                  HACK_RUNTIME_BACKEND: "native",
                  HACK_NATIVE_BINARY: join(tools, "native-runtime"),
                  HACK_NATIVE_HOME: join(root, "native-home"),
                }
              : {}),
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, json: JSON.parse(stdout) };
  };
  return { root, project, tools, calls, forbidden, invoke };
}

for (const native of [false, true]) {
  test(`machine-only ${native ? "native" : "Compose"} audit bypasses invalid project and starts nothing`, async () => {
    const f = await fixture();
    try {
      const before = await readFile(join(f.project, ".hack/hack.project.json"));
      const result = await f.invoke(["--machine", "--json"], native);
      expect(result.json).toMatchObject({ ok: true, data: { schema: 1 } });
      expect([0, 1]).toContain(result.code);
      const checks = result.json.data.checks as {
        id: string;
        scope: string;
        status: string;
      }[];
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.every((check) => check.scope === "machine")).toBe(true);
      expect(
        checks.some((check) =>
          [
            "project",
            "env key",
            "hack gitignore",
            "native settings",
            "lifecycle hygiene",
          ].includes(check.id)
        )
      ).toBe(false);
      expect(checks.some((check) => check.id === "secrets hygiene")).toBe(true);
      expect(result.stdout).not.toContain("PROJECT_CANARY");
      expect(
        await Bun.file(f.forbidden).exists(),
        await Bun.file(f.calls)
          .text()
          .catch(() => "no probes")
      ).toBe(false);
      expect(
        await readFile(join(f.project, ".hack/hack.project.json"))
      ).toEqual(before);
      expect((await readdir(join(f.project, ".hack"))).sort()).toEqual([
        "hack.config.json",
        "hack.project.json",
      ]);
      if (!native) {
        expect(
          checks.find((check) => check.id === "docker daemon")?.status
        ).not.toBe("ok");
        expect(await Bun.file(f.calls).text()).toContain("docker info");
      }
      expect(await Bun.file(join(f.root, "state/projects.json")).exists()).toBe(
        false
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }, 60_000);
}

test("machine mode refuses path selection and every mutating mode before tools run", async () => {
  const f = await fixture();
  try {
    for (const extra of [
      ["--path", f.project],
      ["--fix"],
      ["--fix", "--only", "hack gitignore", "--yes"],
      ["--migrate-env-config"],
      ["--native-preflight"],
      ["--branch", "test"],
      ["--browser-url", "https://example.hack"],
    ]) {
      const result = await f.invoke(["--machine", "--json", ...extra]);
      expect(result.code).not.toBe(0);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "E_USAGE" },
      });
      expect(await Bun.file(f.calls).exists()).toBe(false);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("machine audit excludes gateway probes even with enabled and malformed registered projects", async () => {
  const f = await fixture();
  try {
    const enabled = join(f.root, "registered-enabled/.hack");
    const malformed = join(f.root, "registered-malformed/.hack");
    await mkdir(enabled, { recursive: true });
    await mkdir(malformed, { recursive: true });
    await mkdir(join(f.root, "state"));
    await Bun.write(
      join(enabled, "hack.config.json"),
      JSON.stringify({ controlPlane: { gateway: { enabled: true } } })
    );
    await Bun.write(
      join(malformed, "hack.config.json"),
      "{invalid REGISTERED_PROJECT_CANARY"
    );
    const registry = join(f.root, "state/projects.json");
    await Bun.write(
      registry,
      JSON.stringify({
        version: 1,
        projects: [enabled, malformed].map((projectDir, index) => ({
          id: `fixture-${index}`,
          name: `registered-fixture-${index}`,
          projectDir,
          projectDirName: ".hack",
          repoRoot: resolve(projectDir, ".."),
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      })
    );
    const before = await readFile(registry);
    // Positive control: the real resolver sees both registered checkouts and the parse warning.
    const modulePath = resolve(
      import.meta.dir,
      "../src/control-plane/extensions/gateway/config.ts"
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
      import {resolveGatewayConfig} from ${JSON.stringify(modulePath)};
      const result = await resolveGatewayConfig();
      process.stdout.write(JSON.stringify({enabled:result.config.enabled,warning:result.warnings.some(w=>w.includes("registered-fixture-1"))}));
    `,
      ],
      {
        cwd: f.root,
        env: privateCliEnv({
          root: f.root,
          env: {
            HACK_HOME: join(f.root, "state"),
            HACK_GLOBAL_CONFIG_PATH: join(f.root, "state/hack.config.json"),
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ enabled: true, warning: true });
    const result = await f.invoke(["--machine", "--json"]);
    expect(result.json).toMatchObject({ ok: true, data: { schema: 1 } });
    const ids = result.json.data.checks.map(
      (check: { id: string }) => check.id
    );
    expect(ids).not.toContain("gateway config");
    expect(ids).not.toContain("gateway tokens");
    expect(result.stdout).not.toContain("registered-fixture");
    expect(result.stdout).not.toContain("REGISTERED_PROJECT_CANARY");
    expect(await readFile(registry)).toEqual(before);
    expect(await Bun.file(f.forbidden).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
