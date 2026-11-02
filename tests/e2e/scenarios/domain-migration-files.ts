import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, type Scenario } from "../harness.ts";

/** File migration must work offline and must never start or repair either runtime. */
export const domainMigrationFilesScenario: Scenario = {
  name: "domain-migration-files",
  tier: "local",
  summary:
    "offline domain migration and exact rollback without runtime effects",
  run: async (ctx) => {
    const bin = join(ctx.tempRoot, "runtime-tripwire");
    const marker = join(ctx.tempRoot, "runtime-was-invoked");
    await mkdir(bin);
    for (const name of ["docker", "hack-native"]) {
      const path = join(bin, name);
      await Bun.write(
        path,
        '#!/bin/sh\nprintf "unexpected runtime invocation\\n" > "$DOMAIN_TEST_MARKER"\nexit 97\n'
      );
      await chmod(path, 0o700);
    }
    for (const backend of ["compose", "native"]) {
      const fixture = await createMonorepoFixture({
        parentDir: ctx.tempRoot,
        withHackConfig: true,
        oauthEnabled: true,
      });
      const configFile = join(fixture.hackDir, "hack.config.json");
      const composeFile = join(fixture.hackDir, "docker-compose.yml");
      const files = [configFile, composeFile];
      let withAliases = await Bun.file(composeFile).text();
      for (const host of [fixture.devHost, `api.${fixture.devHost}`]) {
        withAliases = withAliases.replace(
          `caddy: "${host}"`,
          `caddy: "${host}, ${host}.gy"`
        );
      }
      await Bun.write(composeFile, withAliases);
      const original = await Promise.all(
        files.map((path) => Bun.file(path).text())
      );
      const env = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOMAIN_TEST_MARKER: marker,
        ...(backend === "native"
          ? {
              HACK_RUNTIME_BACKEND: "native",
              HACK_NATIVE_BINARY: join(bin, "hack-native"),
              HACK_NATIVE_HOME: join(ctx.tempRoot, "unused-native-home"),
            }
          : {}),
      };
      const cli = async (action: string, codes = [0]) => {
        const result = await ctx.cli({
          args: ["doctor", "--domain-migration", action, "--json"],
          cwd: fixture.root,
          env,
          timeoutMs: 30_000,
        });
        expectExit({
          result,
          codes,
          message: `${backend} migration ${action}`,
        });
        return result;
      };
      await cli("preview");
      for (const [index, path] of files.entries()) {
        expect({
          that: (await Bun.file(path).text()) === original[index],
          message:
            "preview must leave each original file byte-for-byte unchanged",
        });
      }
      const applied: unknown = JSON.parse((await cli("apply")).stdout);
      expect({
        that:
          isRecord(applied) &&
          applied.status === "applied" &&
          applied.toHost === `${fixture.name}.hack.local`,
        message: "CLI must report the applied local domain",
      });
      const config = await Bun.file(configFile).json();
      const compose = await Bun.file(composeFile).text();
      expect({
        that:
          isRecord(config) &&
          config.dev_host === `${fixture.name}.hack.local` &&
          compose.includes(`${fixture.name}.hack.local`) &&
          compose.includes(fixture.devHost) &&
          compose.includes(`${fixture.devHost}.gy`),
        message:
          "new domain must coexist with the original development and OAuth aliases",
      });

      // An edit after migration must not be overwritten by its rollback journal.
      const changed = `${compose}\n# later user edit\n`;
      await Bun.write(composeFile, changed);
      await cli("rollback", [1]);
      expect({
        that: (await Bun.file(composeFile).text()) === changed,
        message: "rollback refusal must preserve a later user edit",
      });
      await Bun.write(composeFile, compose);
      await cli("rollback");
      for (const [index, path] of files.entries()) {
        expect({
          that: (await Bun.file(path).text()) === original[index],
          message: "rollback must restore each original file byte-for-byte",
        });
      }
      expect({
        that: !(await Bun.file(marker).exists()),
        message: "migration must not invoke either selected runtime",
      });
      ctx.log(
        `${backend}: preview, coexistence, conflict refusal and exact rollback passed; no runtime invoked`
      );
    }
  },
};
