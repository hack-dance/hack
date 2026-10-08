import { symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  beginNativeCpuChild,
  finishNativeCpuDiagnostics,
  initializeNativeCpuDiagnostics,
} from "../../src/lib/native-cpu-diagnostics.ts";
import { run } from "../../src/lib/shell.ts";

function burnCpu(microseconds: number) {
  const start = process.cpuUsage().user;
  while (process.cpuUsage().user - start < microseconds) {
    Math.sqrt(microseconds);
  }
}

// This must remain in the cumulative self sample, even before initialization.
burnCpu(80_000);
initializeNativeCpuDiagnostics();
if (process.env.HACK_NATIVE_CPU_REPORT_FD !== undefined) {
  throw new Error("Launch-only report capability was not consumed.");
}
const burnSource = `${burnCpu.toString()}; burnCpu(120_000);`;
const sources = [
  `${burnCpu.toString()}; burnCpu(50_000); process.stdout.write('synthetic-output-canary'); process.stderr.write('synthetic-error-canary');`,
  `const grandchild = Bun.spawn([process.execPath, '-e', ${JSON.stringify(burnSource)}], {env:{PATH:'/usr/bin:/bin'}, stdin:'ignore', stdout:'ignore', stderr:'ignore'}); process.exitCode = await grandchild.exited;`,
];
if (process.argv[2] === "shell") {
  const executable = join(dirname(process.argv[3] ?? ""), "git");
  await symlink(process.execPath, executable);
  const calls: string[] = [];
  let usageReads = 0;
  let callbackCpuMs: number | null = null;
  let callbackRssBytes: number | null = null;
  let settledBeforeSpawnCallback = false;
  let realExit: Promise<number> | undefined;
  const spawn = Bun.spawn;
  // Adapt the overloaded spawn signature without substituting a fake child.
  // Every argument passes unchanged to Bun; only the exact fixture is observed.
  Bun.spawn = ((...args: unknown[]) => {
    const child: Bun.Subprocess = Reflect.apply(spawn, Bun, args);
    if (Array.isArray(args[0]) && args[0][0] === executable) {
      realExit = child.exited;
      const resourceUsage = child.resourceUsage.bind(child);
      child.resourceUsage = () => {
        usageReads += 1;
        return resourceUsage();
      };
    }
    return child;
  }) as typeof Bun.spawn;
  let code: number;
  try {
    code = await run([executable, "-e", "process.exit(17)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeoutMs: 1000,
      onSpawn: async () => {
        // Spawn callbacks can finish after the real child exits. They must still
        // precede onExit without turning that child into a timeout.
        if (!realExit) {
          throw new Error("Expected the original fixture child exit promise.");
        }
        await realExit;
        await Bun.sleep(50);
        settledBeforeSpawnCallback = usageReads === 1;
        calls.push("spawn");
      },
      onExit: async (event) => {
        calls.push("exit");
        callbackCpuMs = event.cpuTimeMs;
        callbackRssBytes = event.maxRssBytes;
        if (event.exitCode !== 17 || event.timedOut || event.cancelled) {
          throw new Error("Diagnostic collector changed shell completion.");
        }
      },
    });
  } finally {
    Bun.spawn = spawn;
  }
  // The existing callback and the diagnostic must share one real usage sample.
  finishNativeCpuDiagnostics(code);
  process.stdout.write(
    JSON.stringify({
      calls,
      usageReads,
      callbackCpuMs,
      callbackRssBytes,
      settledBeforeSpawnCallback,
      code,
    })
  );
} else if (process.argv[2] === "unregistered") {
  const child = Bun.spawn([process.execPath, "-e", burnSource], {
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // A child outside the instrumented owners cannot be discovered by this sink.
  // The independent outer CPU reconciliation must detect the missing work.
  const [, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  finishNativeCpuDiagnostics(exitCode);
  process.exitCode = exitCode;
} else if (process.argv[2] === "pending") {
  const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(100);"], {
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = beginNativeCpuChild(child, "other");
  // Deliberately do not complete this registration before the sole report.
  finishNativeCpuDiagnostics(0);
  const [, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  done(exitCode);
  process.exitCode = exitCode;
} else {
  for (const source of sources) {
    const child = Bun.spawn(
      [process.execPath, "-e", source, "synthetic-argument-canary"],
      {
        env: {
          PATH: "/usr/bin:/bin",
          SYNTHETIC_SECRET: "synthetic-env-canary",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const done = beginNativeCpuChild(child, "other");
    const [, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    done(exitCode);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  }
  finishNativeCpuDiagnostics(
    typeof process.exitCode === "number" ? process.exitCode : 0
  );
}
