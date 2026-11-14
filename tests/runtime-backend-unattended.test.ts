import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntimeBackend } from "../src/backends/runtime-backend.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("real unattended Compose subprocess cannot build or pull to recover a missing image", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-unattended-compose-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const compose = join(root, "compose.yml");
  await writeFile(
    compose,
    "services:\n  app:\n    image: example.invalid/locally-prepared\n    build: .\n"
  );
  const called = join(root, "called.json");
  const unsafe = join(root, "build-or-pull-ran");
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("config") && args.includes("--format")) { process.stdout.write(JSON.stringify({name:"fixture",services:{app:{image:"example.invalid/locally-prepared:latest"}}}));process.exit(0); }
if(args[0]==="image" && args[1]==="inspect") { process.stderr.write("Error response from daemon: No such image: example.invalid/locally-prepared:latest\\n");process.exit(1); }
await Bun.write(${JSON.stringify(called)},JSON.stringify(args));
const pull=args.indexOf("--pull"); const dotenv=args.indexOf("--env-file");
if(!args.includes("--no-build")||pull<0||args[pull+1]!=="never"||dotenv<0||args[dotenv+1]!=="/dev/null") {
 await Bun.write(${JSON.stringify(unsafe)},"unsafe fallback");process.exit(0);
}
process.exit(1);
`,
    { mode: 0o755 }
  );
  await expect(
    composeRuntimeBackend.up({
      composeFiles: [compose],
      cwd: root,
      env: privateCliEnv({ root, env: { PATH: bin } }),
      detach: true,
      unattended: true,
      imageTimeoutMs: 1000,
      startupTimeoutMs: 1000,
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "image_requires_manual_start" },
  });
  expect(await Bun.file(unsafe).exists()).toBe(false);
  expect(await Bun.file(called).exists()).toBe(false);
});

for (const scenario of [
  "unsafe-existing",
  "safe-existing",
  "safe-missing",
  "generated-bind",
] as const) {
  test(`real unattended resolved-storage probes handle ${scenario} before any unsafe up`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-storage-probe-"));
    roots.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    const called = join(root, "up-calls");
    const compose = join(root, "compose.yml");
    await writeFile(
      compose,
      "name: fixture\nservices:\n  app:\n    image: example.invalid/app\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n"
    );
    const model = {
      name: "fixture",
      services: {
        app: {
          image: "example.invalid/app",
          environment: { PRIVATE_SENTINEL: "synthetic-model-value" },
          volumes: [
            scenario === "generated-bind"
              ? {
                  type: "bind",
                  source: "/host/private",
                  target: "/data",
                  read_only: true,
                }
              : { type: "volume", source: "data", target: "/data" },
          ],
        },
      },
      volumes: { data: { name: "fixture_data" } },
    };
    const inspected = {
      Name: "fixture_data",
      Driver: "local",
      Options:
        scenario === "unsafe-existing"
          ? { device: "/host/private", o: "bind", type: "none" }
          : null,
      Labels: {
        "com.docker.compose.project": "fixture",
        "com.docker.compose.volume": "data",
      },
    };
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("config")){process.stdout.write(${JSON.stringify(JSON.stringify(model))});process.exit(0);}
if(args[0]==="image"){process.stdout.write("sha256:${"a".repeat(64)}");process.exit(0);}
if(args[0]==="volume"){
 if(${JSON.stringify(scenario)}==="safe-missing" && !(await Bun.file(${JSON.stringify(called)}).exists())){process.stderr.write("Error response from daemon: get fixture_data: no such volume\\n");process.exit(1);}
 process.stdout.write(${JSON.stringify(JSON.stringify(inspected))});process.exit(0);
}
if(args.includes("up")){const f=Bun.file(${JSON.stringify(called)});await Bun.write(f,(await f.exists()?await f.text():"")+"up\\n");process.exit(0);}
process.exit(99);
`,
      { mode: 0o755 }
    );
    const action = composeRuntimeBackend.up({
      composeFiles: [compose, "generated.yml"],
      cwd: root,
      env: privateCliEnv({ root, env: { PATH: bin } }),
      detach: true,
      unattended: true,
      imageTimeoutMs: 10_000,
      startupTimeoutMs: 10_000,
    });
    if (scenario === "unsafe-existing" || scenario === "generated-bind") {
      await expect(action).rejects.toMatchObject({
        code: "E_PERMISSION",
        detail: { reason: "compose_inputs_require_manual_start" },
      });
      expect(await Bun.file(called).exists()).toBe(false);
    } else {
      expect(await action).toBe(0);
      expect((await Bun.file(called).text()).trim().split("\n")).toHaveLength(
        2
      );
    }
  });
}
