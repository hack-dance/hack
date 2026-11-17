import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUnattendedImages } from "../src/backends/compose-unattended-preflight.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

for (const scenario of ["present", "missing", "probe-error"] as const) {
  test(`routing image preflight uses local inspection only: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-routing-images-"));
    try {
      const bin = join(root, "bin");
      const calls = join(root, "calls");
      await mkdir(bin);
      await writeFile(
        join(bin, "docker"),
        `#!${process.execPath}
const args=process.argv.slice(2);
await Bun.write(process.env.CALLS,(await Bun.file(process.env.CALLS).text().catch(()=>""))+JSON.stringify(args)+"\\n");
if(args.includes("config") && args.includes("--images")) {console.log("example.invalid/routing:prepared");process.exit(0);}
if(args[0]==="image" && args[1]==="inspect") {
 if(process.env.SCENARIO==="missing") {process.stderr.write("Error response from daemon: No such image: example.invalid/routing:prepared");process.exit(1);}
 if(process.env.SCENARIO==="probe-error") process.exit(7);
 console.log("sha256:"+"a".repeat(64));process.exit(0);
}
process.exit(99);
`,
        { mode: 0o755 }
      );
      const result = inspectUnattendedImages({
        composeArgs: [
          "docker",
          "compose",
          "--env-file",
          "/dev/null",
          "-f",
          join(root, "compose.yml"),
        ],
        cwd: root,
        env: privateCliEnv({
          root,
          env: { PATH: bin, CALLS: calls, SCENARIO: scenario },
        }),
      });
      if (scenario === "missing") {
        await expect(result).rejects.toMatchObject({
          detail: { reason: "image_requires_manual_start" },
        });
      } else {
        expect(await result).toBe(scenario === "present" ? 0 : 7);
      }
      const commands: string[][] = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(commands).toHaveLength(2);
      expect(commands[0]?.slice(-2)).toEqual(["config", "--images"]);
      expect(commands[1]?.slice(0, 2)).toEqual(["image", "inspect"]);
      expect(commands.flat()).not.toContain("pull");
      expect(commands.flat()).not.toContain("up");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
