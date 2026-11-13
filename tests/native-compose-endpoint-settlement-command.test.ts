import { expect, test } from "bun:test";
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
