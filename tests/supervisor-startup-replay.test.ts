import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "../src/control-plane/extensions/supervisor/job-store.ts";
import { createSupervisorService } from "../src/control-plane/extensions/supervisor/service.ts";
import { logger } from "../src/ui/logger.ts";

/** Additional bug characterization, outside the five formal properties. */
for (const failurePoint of ["running-status", "job.started"] as const) {
  test(`startup persistence bug: ${failurePoint} failure leaves a live, uncancellable child`, async () => {
    const dir = await mkdtemp(
      join(
        process.env.HACK_SUPERVISOR_REPLAY_DATA ?? tmpdir(),
        "hack-supervisor-startup-"
      )
    );
    const projectDir = join(dir, ".hack");
    const exited = Promise.withResolvers<number>();
    let alive = false;
    let signals = 0;
    let failures = 0;
    let run: Promise<unknown> | undefined;
    const proc = {
      pid: 10_001,
      stdout: null,
      stderr: null,
      exited: exited.promise,
      kill: () => {
        signals += 1;
        alive = false;
        exited.resolve(143);
      },
    };
    const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
      alive = true;
      return proc;
    }) as unknown as typeof Bun.spawn);
    try {
      const store = await createJobStore({ projectDir });
      const fault = new Error(
        `Injected startup ${failurePoint} write rejection`
      );
      const errors: string[] = [];
      const service = createSupervisorService({
        logger: { ...logger, error: ({ message }) => errors.push(message) },
        createStore: async () => ({
          ...store,
          updateJobStatus: async (input) => {
            if (
              failurePoint === "running-status" &&
              input.status === "running" &&
              failures === 0
            ) {
              failures += 1;
              throw fault;
            }
            return await store.updateJobStatus(input);
          },
          appendEvent: async (input) => {
            if (
              failurePoint === "job.started" &&
              input.type === "job.started" &&
              failures === 0
            ) {
              failures += 1;
              throw fault;
            }
            return await store.appendEvent(input);
          },
        }),
      });
      const created = await service.createJob({
        projectDir,
        runner: "generic",
        command: ["controlled-child"],
      });
      run = created.run;
      expect(await created.run).toEqual({
        jobId: created.jobId,
        status: "failed",
        exitCode: 1,
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(failures).toBe(1);
      expect(errors).toEqual([`Job failed: ${fault.message}`]);
      const input = { projectDir, jobId: created.jobId };
      expect((await service.getJob(input))?.status).toBe("failed");
      const events = await store.readEvents(input);
      expect(events.map((event) => event.type)).toEqual([
        "job.created",
        "job.starting",
        "job.failed",
      ]);
      expect(events.at(-1)?.payload?.error).toBe(fault.message);
      expect(alive).toBe(true);
      expect(await service.cancelJob(input)).toEqual({
        ok: false,
        status: "not_running",
      });
      expect(alive).toBe(true);
      expect(signals).toBe(0);
    } finally {
      alive = false;
      exited.resolve(0);
      await run?.catch(() => {});
      spawn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
