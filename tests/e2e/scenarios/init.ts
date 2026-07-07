import { join } from "node:path";

import { createMonorepoFixture, randomProjectName } from "../fixture.ts";
import { expect, expectExit, type Scenario } from "../harness.ts";

/**
 * `hack init --auto` in a repo without .hack/ must be fully non-interactive
 * and generate the canonical project files (config, compose, env yaml) plus
 * the .hack/.internal gitignore entry.
 */
export const initScenario: Scenario = {
  name: "init",
  tier: "local",
  summary: "hack init --auto scaffolds .hack/ non-interactively",
  run: async (ctx) => {
    const name = randomProjectName();
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
      name,
    });

    const result = await ctx.cli({
      args: ["init", "--auto", "--name", name, "--dev-host", `${name}.hack`],
      cwd: fixture.root,
    });
    expectExit({
      result,
      codes: [0],
      message: "hack init --auto should succeed without prompting",
    });

    const configText = await Bun.file(
      join(fixture.hackDir, "hack.config.json")
    ).text();
    const config = JSON.parse(configText) as Record<string, unknown>;
    expect({
      that: config.name === name,
      message: `hack.config.json name should be "${name}", got "${String(config.name)}"`,
      result,
    });
    expect({
      that: config.dev_host === `${name}.hack`,
      message: "hack.config.json dev_host should match --dev-host",
      result,
    });

    for (const file of ["docker-compose.yml", "hack.env.default.yaml"]) {
      expect({
        that: await Bun.file(join(fixture.hackDir, file)).exists(),
        message: `init should create .hack/${file}`,
        result,
      });
    }

    const hackGitignore = await Bun.file(
      join(fixture.hackDir, ".gitignore")
    ).text();
    for (const entry of [".internal/", ".branch/", ".env.state.json"]) {
      expect({
        that: hackGitignore.includes(entry),
        message: `init should write ${entry} to the committed .hack/.gitignore`,
        result,
      });
    }

    const rerun = await ctx.cli({
      args: ["init", "--auto", "--name", name],
      cwd: fixture.root,
    });
    expect({
      that: rerun.exitCode !== 0,
      message:
        "hack init --auto should refuse to overwrite an existing .hack/ (non-zero exit)",
      result: rerun,
    });
  },
};
