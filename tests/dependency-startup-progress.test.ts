import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDependencyStartupProgress } from "../src/lib/dependency-startup-progress.ts";

const dirs: string[] = [];
const siblings: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const sibling of siblings.splice(0)) {
    sibling.kill("SIGKILL");
    await sibling.exited;
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});
async function fixture(mode = "valid") {
  const dir = await mkdtemp(join(tmpdir(), "hack-progress-"));
  dirs.push(dir);
  const pidfile = join(dir, "pids");
  siblings.push(
    Bun.spawn(["/bin/sleep", "20"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
  );
  const descendantCode = `import {appendFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); appendFileSync(${JSON.stringify(pidfile)},process.pid+'\\n'); console.log('ready'); setInterval(()=>{},1000);`;

  const docker = join(dir, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(pidfile)},process.pid+'\\n');
const id=process.argv[2]==='inspect'?process.argv.at(-1):'a'.repeat(64), mode=${JSON.stringify(mode)};
if(process.argv[2]!=='inspect') {
 const helper=Bun.spawn([${JSON.stringify(process.execPath)},'-e',${JSON.stringify(descendantCode)}],{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
 const ready=helper.stdout.getReader(); await ready.read(); ready.releaseLock();
}
const labels={'com.docker.compose.project':'fixture','com.docker.compose.service':'deps'};
const startedAt=(mode==='stale'||(mode==='stale-then-fresh'&&id[0]==='a'))?'2000-01-01T00:00:00.000Z':new Date().toISOString();
if(process.argv[2]==='events') {
 if(mode==='byte-budget')process.stdout.write('x'.repeat(1100000));
 console.log('not json');
 console.log(JSON.stringify({Type:'container',Action:'start',Actor:{ID:id,Attributes:labels}}));
 if(mode==='stale-then-fresh')console.log(JSON.stringify({Type:'container',Action:'start',Actor:{ID:'b'.repeat(64),Attributes:labels}}));
 if(mode==='natural-exit')setTimeout(()=>process.exit(0),300);
 else setInterval(()=>{},1000);
} else if(process.argv[2]==='inspect') {
 if(mode==='foreign') labels['com.docker.compose.project']='other';
 console.log(JSON.stringify({id,labels,startedAt}));
} else {
 console.log('private noisy message');
 console.log('x'.repeat(5000)+'HACK_DEPENDENCY_PHASE_V1 ready');
 process.stdout.write('HACK_DEPENDENCY_PHASE_V1 wait');
 setTimeout(()=>{console.log('ing');console.log('HACK_DEPENDENCY_PHASE_V1 waiting');console.log('HACK_DEPENDENCY_PHASE_V1 installing');},10);
 setInterval(()=>{},1000);
}
`
  );
  await chmod(docker, 0o700);
  return {
    dir,
    pidfile,
    options: {
      services: ["deps"],
      project: "fixture",
      cwd: dir,
      env: { PATH: dir },
    },
  };
}
async function gone(file: string) {
  const pids = (await readFile(file, "utf8")).trim().split("\n").map(Number);
  for (const pid of pids) {
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(25);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }
  for (const sibling of siblings) {
    expect(() => process.kill(sibling.pid, 0)).not.toThrow();
  }
}

test("phase arrives during held startup, strict bounded frames deduplicate and cleanup", async () => {
  const f = await fixture("stale-then-fresh");
  const phases: string[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release?.(), 2000);
  const result = await withDependencyStartupProgress({
    ...f.options,
    onPhase: (service, phase) => {
      phases.push(`${service}:${phase}`);
      if (phase === "installing") {
        release?.();
      }
    },
    run: async () => {
      await held;
      expect(phases).toContain("deps:installing");
      return 42;
    },
  });
  clearTimeout(timer);
  expect(result).toBe(42);
  expect(phases).toEqual(["deps:waiting", "deps:installing"]);
  await gone(f.pidfile);
});
test("stale or foreign inspection emits no phases and startup errors remain unchanged", async () => {
  for (const mode of ["stale", "foreign"]) {
    const f = await fixture(mode);
    const phases: string[] = [];
    const failure = new Error("startup failure");
    await expect(
      withDependencyStartupProgress({
        ...f.options,
        onPhase: (_, phase) => phases.push(phase),
        run: async () => {
          const deadline = Date.now() + 3000;
          let inspected = false;
          while (Date.now() < deadline) {
            const content = await readFile(f.pidfile, "utf8").catch(() => "");
            if (content.trim().split("\n").filter(Boolean).length >= 3) {
              inspected = true;
              break;
            }
            await Bun.sleep(25);
          }
          expect(inspected).toBe(true);
          await Bun.sleep(100);
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(phases).toEqual([]);
    await gone(f.pidfile);
  }
});
test("empty selection never creates an observer", async () => {
  expect(
    await withDependencyStartupProgress({
      services: [],
      project: "fixture",
      cwd: "/nonexistent",
      onPhase: () => {
        throw new Error("unexpected");
      },
      run: async () => 7,
    })
  ).toBe(7);
});

test("SIGTERM reaps observer children and preserves default owner termination", async () => {
  const f = await fixture();
  const driver = join(f.dir, "driver.ts");
  const modulePath = new URL(
    "../src/lib/dependency-startup-progress.ts",
    import.meta.url
  ).pathname;
  await writeFile(
    driver,
    `import {withDependencyStartupProgress} from ${JSON.stringify(modulePath)};
await withDependencyStartupProgress({...${JSON.stringify(f.options)},onPhase:(_,phase)=>{if(phase==='installing')console.log('ready-to-signal');},run:()=>new Promise(()=>{})});`
  );
  const child = Bun.spawn([process.execPath, driver], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5000,
  });
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (!output.includes("ready-to-signal")) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      output += new TextDecoder().decode(chunk.value);
    }
    expect(output).toContain("ready-to-signal");
    child.kill("SIGTERM");
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");
    await gone(f.pidfile);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
    await reader.cancel();
    reader.releaseLock();
  }
}, 7000);

test("total byte budget stops noisy event streams without forwarding output", async () => {
  const f = await fixture("byte-budget");
  let notices = 0;
  const phases: string[] = [];
  let release: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release?.(), 2000);
  try {
    expect(
      await withDependencyStartupProgress({
        ...f.options,
        onPhase: (_, phase) => phases.push(phase),
        onUnavailable: () => {
          notices += 1;
          release?.();
        },
        run: async () => {
          await stopped;
          return 19;
        },
      })
    ).toBe(19);
    expect(notices).toBe(1);
    expect(phases).toEqual([]);
    await gone(f.pidfile);
  } finally {
    clearTimeout(timer);
  }
});

test("natural event exit retires its captured helpers before startup finishes", async () => {
  const f = await fixture("natural-exit");
  let release: (() => void) | undefined;
  const unavailable = new Promise<void>((resolve) => {
    release = resolve;
  });
  const timer = setTimeout(() => release?.(), 3000);
  try {
    await withDependencyStartupProgress({
      ...f.options,
      onPhase: () => undefined,
      onUnavailable: () => release?.(),
      run: async () => {
        await unavailable;
        // Events and its helper are the first two owned PIDs; logs remain live until run ends.
        const pids = (await readFile(f.pidfile, "utf8"))
          .trim()
          .split("\n")
          .map(Number)
          .slice(0, 2);
        for (const pid of pids) {
          let alive = true;
          for (let attempt = 0; attempt < 60 && alive; attempt += 1) {
            try {
              process.kill(pid, 0);
              await Bun.sleep(25);
            } catch {
              alive = false;
            }
          }
          expect(alive).toBe(false);
        }
      },
    });
    await gone(f.pidfile);
  } finally {
    clearTimeout(timer);
  }
});
