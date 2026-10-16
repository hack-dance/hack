import { parseArgs } from "node:util";
import { isRecord } from "../src/lib/guards.ts";
import { exec } from "../src/lib/shell.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    container: { type: "string" },
    runtime: { type: "string", default: "bun" },
    storage: { type: "boolean", default: false },
  },
});
if (!(values.container && /^[\w][\w.-]*$/.test(values.container))) {
  throw new Error(
    "Use --container <container-id-or-name> [--runtime bun|node] [--storage]"
  );
}
if (values.runtime !== "bun" && values.runtime !== "node") {
  throw new Error(
    "--runtime must be bun or node (installed inside the container)"
  );
}

const format =
  '{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State.Status}},"oomKilled":{{.State.OOMKilled}},"restartCount":{{.RestartCount}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"mounts":{{json .Mounts}},"healthcheckIntervalNs":{{with (index .Config "Healthcheck")}}{{json (index . "Interval")}}{{else}}null{{end}},"writableLayerBytes":{{json (index . "SizeRw")}}}';
const metadata = await exec(
  [
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
    format,
    ...(values.storage ? ["--size"] : []),
    values.container,
  ],
  { stdin: "ignore", timeoutMs: 15_000 }
);
if (metadata.exitCode !== 0) {
  throw new Error("Container inspection unavailable");
}
const container: unknown = JSON.parse(metadata.stdout);
if (!isRecord(container)) {
  throw new Error("Invalid container metadata");
}

// Runs under either Node or Bun. Fixed /proc and cgroup paths only: never reads argv, env or application files.
const probe = String.raw`
const fs = require("node:fs");
const read = (path) => { try { return fs.readFileSync(path, "utf8"); } catch { return null; } };
const numeric = (path) => { const value = read(path); return value === null ? null : value.trim() === "max" ? "max" : Number(value.trim()); };
const counters = (path) => { const value = read(path); return value === null ? null : Object.fromEntries(value.trim().split("\n").map((line) => { const [key, number] = line.split(/\s+/); return [key, Number(number)]; })); };
const processes = [];
const deadline = Date.now() + 3000;
let fdCount = 0, truncated = false;
if (process.platform === "linux") {
  for (const pid of fs.readdirSync("/proc").filter((value) => /^\d+$/.test(value))) {
    if (Number(pid) === process.pid) continue;
    if (processes.length >= 128 || Date.now() > deadline) { truncated = true; break; }
    const status = read("/proc/" + pid + "/status");
    if (!status) continue;
    const fields = Object.fromEntries(status.trim().split("\n").map((line) => { const i = line.indexOf(":"); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
    let watches = 0, descriptors = 0, watchesAvailable = true;
    try {
      for (const fd of fs.readdirSync("/proc/" + pid + "/fdinfo")) {
        if (++fdCount > 4096 || Date.now() > deadline) { truncated = true; watchesAvailable = false; break; }
        const info = read("/proc/" + pid + "/fdinfo/" + fd);
        if (info === null) { watchesAvailable = false; continue; }
        const count = (info.match(/^inotify wd:/gm) || []).length;
        if (count) { descriptors++; watches += count; }
      }
    } catch { watchesAvailable = false; }
    processes.push({ pid: Number(pid), parentPid: Number(fields.PPid), name: fields.Name, rssBytes: fields.VmRSS ? parseInt(fields.VmRSS) * 1024 : null, threads: Number(fields.Threads), inotifyDescriptors: watchesAvailable ? descriptors : null, inotifyWatchEntries: watchesAvailable ? watches : null });
  }
}
console.log(JSON.stringify({ sampledAt: new Date().toISOString(), platform: process.platform, truncated, probeRssBytes: process.memoryUsage().rss, memoryCurrentBytes: numeric("/sys/fs/cgroup/memory.current"), memoryPeakBytes: numeric("/sys/fs/cgroup/memory.peak"), memoryLimitBytes: numeric("/sys/fs/cgroup/memory.max"), memoryStat: counters("/sys/fs/cgroup/memory.stat"), memoryEvents: counters("/sys/fs/cgroup/memory.events"), cpuStat: counters("/sys/fs/cgroup/cpu.stat"), processes }));
`;

let resources: unknown = null;
let probeStatus = "not_running";
if (container.state === "running") {
  const child = Bun.spawn(
    ["docker", "exec", "-i", values.container, values.runtime, "-"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000 }
  );
  child.stdin.write(probe);
  child.stdin.end();
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  probeStatus = exitCode === 0 ? "available" : "unavailable";
  if (exitCode === 0) {
    resources = JSON.parse(stdout);
  }
}

let changedPrefixes: Record<string, number> | null = null;
if (values.storage) {
  const diff = await exec(["docker", "diff", values.container], {
    stdin: "ignore",
    timeoutMs: 15_000,
  });
  if (diff.exitCode === 0) {
    changedPrefixes = {};
    for (const line of diff.stdout.split("\n").filter(Boolean)) {
      const prefix = line.slice(2).split("/").slice(0, 3).join("/");
      changedPrefixes[prefix] = (changedPrefixes[prefix] ?? 0) + 1;
    }
  }
}
process.stdout.write(
  `${JSON.stringify({ container, probeStatus, resources, changedPrefixes }, null, 2)}\n`
);
