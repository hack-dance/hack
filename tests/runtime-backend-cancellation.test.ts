import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withAutostartProjectLock } from "../src/lib/autostart-project-lock.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
const drivers: ReturnType<typeof Bun.spawn>[] = [];
const ownedPhases: { readonly pid: number; readonly identity: string }[] = [];
async function identity(pid: number): Promise<string | null> {
  const child = Bun.spawn(
    ["/bin/ps", "-o", "pgid=,lstart=", "-p", String(pid)],
    {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  const output = (await new Response(child.stdout).text()).trim();
  return (await child.exited) === 0 && output ? output : null;
}
afterEach(async () => {
  for (const child of drivers.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  for (const phase of ownedPhases.splice(0)) {
    if (
      (await identity(phase.pid)) === phase.identity &&
      (await live(phase.pid))
    ) {
      process.kill(phase.pid, "SIGKILL");
      const deadline = Date.now() + 1000;
      while ((await live(phase.pid)) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      if (await live(phase.pid)) {
        throw new Error("Owned phase cleanup unconfirmed; fixture retained.");
      }
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function live(pid: number): Promise<boolean> {
  const child = Bun.spawn(["/bin/ps", "-o", "stat=", "-p", String(pid)], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const state = (await new Response(child.stdout).text()).trim();
  await child.exited;
  return state.length > 0 && !state.startsWith("Z");
}
async function waitReady(path: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 5000;
  while (
    !(await Bun.file(path).exists()) &&
    Date.now() < deadline &&
    child.exitCode === null
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(path).exists()).toBe(true);
}
for (const phase of ["images", "start"]) {
  test(`cancelled detached Compose ${phase} settles resistant descendants before releasing the startup mutex`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-compose-cancel-"));
    roots.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    const ready = join(root, "ready.json");
    const late = join(root, "late-publication");
    const receipt = join(root, "receipt.json");
    const beforeStart = join(root, "before-start");
    const descendantScript = `process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});await Bun.write(${JSON.stringify(join(root, "descendant-ready"))},String(process.pid));setTimeout(()=>void Bun.write(${JSON.stringify(late)},"must not publish"),3500);setInterval(()=>{},1000);`;
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
const selected=process.argv.includes("--no-start")?"images":"start";
if(selected!==${JSON.stringify(phase)}) process.exit(0);
process.on("SIGTERM",()=>{ ${phase === "start" ? "process.exit(0);" : "/* resistant leader */"} });
process.on("SIGINT",()=>{});
const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(descendantScript)}],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
const deadline=Date.now()+3000;while(!(await Bun.file(${JSON.stringify(join(root, "descendant-ready"))}).exists())){if(Date.now()>deadline)process.exit(98);await Bun.sleep(10);}
await Bun.write(${JSON.stringify(ready)},JSON.stringify({leader:process.pid,descendant:child.pid}));
setInterval(()=>{},1000);
`,
      { mode: 0o755 }
    );
    const registryPath = join(root, "home", ".hack", "projects.json");
    const scope = {
      projectId: "example-id",
      composeProject: "example",
      branch: null,
    };
    const driver = join(root, "driver.ts");
    await writeFile(
      driver,
      `
import {composeRuntimeBackend} from ${JSON.stringify(resolve("src/backends/runtime-backend.ts"))};
import {withAutostartProjectLock} from ${JSON.stringify(resolve("src/lib/autostart-project-lock.ts"))};
const code=await withAutostartProjectLock({registryPath:${JSON.stringify(registryPath)},scope:${JSON.stringify(scope)},run:()=>composeRuntimeBackend.up({composeFiles:["compose.yml"],composeProject:"example",cwd:${JSON.stringify(root)},env:{PATH:${JSON.stringify(bin)}},detach:true,imageTimeoutMs:10000,startupTimeoutMs:10000,beforeStart:async()=>{await Bun.write(${JSON.stringify(beforeStart)},"entered");}})});
await Bun.write(${JSON.stringify(receipt)},JSON.stringify({code}));
process.exitCode=code===143?0:1;
`
    );
    const env = privateCliEnv({
      root,
      home: join(root, "home"),
      env: { PATH: bin },
    });
    await mkdir(join(root, "home", ".hack"), { recursive: true });
    const child = Bun.spawn([process.execPath, driver], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    drivers.push(child);
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    await waitReady(ready, child);
    const pids: { leader: number; descendant: number } =
      await Bun.file(ready).json();
    for (const pid of [pids.leader, pids.descendant]) {
      const proof = await identity(pid);
      if (proof) {
        ownedPhases.push({ pid, identity: proof });
      }
    }
    let observedAtRelease:
      | { leader: boolean; descendant: boolean; late: boolean }
      | undefined;
    const queued = withAutostartProjectLock({
      registryPath,
      scope,
      run: async () => {
        observedAtRelease = {
          leader: await live(pids.leader),
          descendant: await live(pids.descendant),
          late: await Bun.file(late).exists(),
        };
      },
    });
    const started = Date.now();
    child.kill("SIGTERM");
    const [stdout, stderr, code] = await output;
    expect(code, stdout + stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(4500);
    await queued;
    expect(observedAtRelease).toEqual({
      leader: false,
      descendant: false,
      late: false,
    });
    expect(await Bun.file(receipt).json()).toEqual({ code: 143 });
    expect(await Bun.file(beforeStart).exists()).toBe(phase === "start");
  }, 10_000);
}
