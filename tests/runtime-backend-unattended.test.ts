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
if(args.includes("config") && args.includes("--images")) { process.stdout.write("example.invalid/locally-prepared:latest\\n");process.exit(0); }
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
