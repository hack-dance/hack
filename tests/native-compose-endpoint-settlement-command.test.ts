import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture, invoke, state } from "./helpers/native-compose-command.ts";

/**
 * Drive the source CLI through both HACK-2141 call sites. The synthetic engine
 * keeps the placeholder for a whole failing query, then returns its owned ID.
 * Each case must fail if its command-level opt-in/wrapper is removed.
 */
for (const phase of ["readiness", "prepared-guard"] as const) {
  test(`source CLI up reacquires a next-query endpoint at ${phase}`, async () => {
    const root = await fixture("", false, { noHooks: true });
    const path = join(root, ".hack/hack.project.json");
    const source = await Bun.file(path).json();
    source.services.web.restart = { kind: "on-failure", max_retries: 2 };
    await Bun.write(path, JSON.stringify(source));
    await Bun.write(
      join(root, "restart-placeholder-next-query"),
      JSON.stringify({ phase })
    );

    const result = await invoke(root, ["up", "--detach", "--json"], 10_000);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { status: "ready" },
    });
    const scans = (
      await Bun.file(join(root, "restart-placeholder-scans")).text()
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(scans.slice(0, phase === "readiness" ? 4 : 5)).toEqual(
      phase === "readiness"
        ? [
            { scan: 0, shape: "placeholder" },
            { scan: 1, shape: "placeholder" },
            { scan: 2, shape: "member" },
            { scan: 3, shape: "member" },
          ]
        : [
            { scan: 0, shape: "member" },
            { scan: 1, shape: "member" },
            { scan: 2, shape: "placeholder" },
            { scan: 3, shape: "member" },
            { scan: 4, shape: "member" },
          ]
    );
    const requests = (await Bun.file(join(root, "requests")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.filter(
        (args: string[]) => args[0] === "compose" && args.includes("up")
      )
    ).toHaveLength(1);
    expect(await state(root)).toMatchObject({ pending: false, stopped: false });
  }, 30_000);
}

for (const mode of ["once", "always"] as const) {
  test(`source CLI up handles a Docker readiness read that stalls ${mode}`, async () => {
    const root = await fixture("", false, {
      noHooks: true,
      onDocker: `
        const stalls=root+"/stalled-readiness-reads";
        if (args[0]==="container" && args[1]==="inspect" &&
            await Bun.file(engine).exists() && await Bun.file(root+"/stall-readiness").exists() &&
            (${mode === "always"} || !await Bun.file(stalls).exists())) {
          await appendFile(stalls,"inspect\\n");
          // Hold the fake read until the CLI times it out and reaps it.
          await Bun.sleep(60_000);
        }
      `,
    });
    const fault = join(root, "stall-readiness");
    await Bun.write(fault, "");
    const args = ["up", "--detach", "--json"];
    const result = await invoke(root, args, 6000, 25_000);
    const stalls = await Bun.file(join(root, "stalled-readiness-reads")).text();
    if (mode === "once") {
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: { status: "ready" },
      });
      expect(stalls).toBe("inspect\n");
      expect(await state(root)).toMatchObject({
        pending: false,
        stopped: false,
      });
    } else {
      expect(result.code, result.stderr + result.stdout).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "E_RECOVERY_REQUIRED",
          detail: {
            native_compose_effect_refusal: {
              stage: "compose-readiness",
              reason: "probe-timeout",
            },
          },
        },
      });
      expect(stalls).toBe("inspect\ninspect\n");
      const replay = await invoke(root, args, 6000);
      expect(replay.code, replay.stderr + replay.stdout).toBe(1);
      expect(JSON.parse(replay.stdout)).toMatchObject({
        ok: false,
        error: { code: "E_RECOVERY_REQUIRED" },
      });
      await rm(fault);
      expect(await state(root)).toMatchObject({ pending: true });
      const down = await invoke(root, ["down", "--recover", "--json"], 6000);
      expect(down.code, down.stderr + down.stdout).toBe(0);
      expect(await state(root)).toMatchObject({
        pending: false,
        stopped: true,
      });
    }
    const requests = (await Bun.file(join(root, "requests")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.filter(
        (args: string[]) => args[0] === "compose" && args.includes("up")
      )
    ).toHaveLength(1);
  }, 40_000);
}
