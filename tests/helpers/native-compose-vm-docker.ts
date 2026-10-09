import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  VM_FILE_IMAGE_FORMAT,
  VM_FILE_OBSERVER_PROGRAM,
  VM_FILE_VERIFY_PROGRAM,
  VM_FILE_WRITER_PROGRAM,
  type VmFileFacts,
} from "../../src/lib/native-compose-vm-file-protocol.ts";

type Mount = {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  RW: boolean;
};
type Row = {
  id: string;
  name: string;
  created: string;
  image: string;
  labels: Record<string, string>;
  entrypoint: string[];
  command: string[];
  user: string;
  openStdin: boolean;
  tty: boolean;
  network: string;
  ports: null;
  restart: { Name: string; MaximumRetryCount: number };
  readonly: boolean;
  privileged: boolean;
  capAdd: string[];
  capDrop: string[];
  security: string[];
  autoRemove: boolean;
  mounts: Mount[];
  running: boolean;
  status: string;
  exitCode: number;
  restarts: number;
  execs: null;
};
type Volume = {
  name: string;
  driver: string;
  scope: string;
  created: string;
  mountpoint: string;
  labels: Record<string, string>;
  options: null;
};
type FixtureState = {
  volume: Volume | null;
  containers: Record<string, Row>;
  facts: VmFileFacts | null;
};
const root = process.env.HACK_TEST_VM_ROOT;
if (!(root?.startsWith("/") && root.includes("/native-vm-files-"))) {
  process.exit(97);
}
const args = process.argv.slice(2),
  statePath = `${root}/engine.json`;
const ownerSource = await readFile(
  resolve(import.meta.dir, "../../src/lib/native-compose-vm-file-owner.ts"),
  "utf8"
);
function format(name: string) {
  const match = ownerSource.match(
    new RegExp(`const ${name}\\s*=\\s*'([^']+)';`)
  );
  if (!match?.[1]) {
    process.exit(97);
  }
  return match[1];
}
const formats = {
  volume: format("VOLUME_FORMAT"),
  container: format("CONTAINER_FORMAT"),
};
const programs = {
  writer: VM_FILE_WRITER_PROGRAM,
  observer: VM_FILE_OBSERVER_PROGRAM,
};
const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex"),
  same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const has = async (name: string) => Bun.file(`${root}/${name}`).exists();
// Only this exclusive private fixture produces the state; it is never engine input.
const state: FixtureState = (await Bun.file(statePath).exists())
  ? ((await Bun.file(statePath).json()) as FixtureState)
  : { volume: null, containers: {}, facts: null };
await appendFile(`${root}/commands.jsonl`, `${JSON.stringify(args)}\n`);
async function save() {
  await writeFile(statePath, JSON.stringify(state));
}
function refuse(): never {
  process.exit(97);
}
function exact(expected: unknown) {
  if (!same(args, expected)) {
    refuse();
  }
}
const helper = `sha256:${"a".repeat(64)}`,
  app = `sha256:${"b".repeat(64)}`;
const ownershipSource = await readFile(
  resolve(import.meta.dir, "../../src/lib/native-compose-ownership.ts"),
  "utf8"
);
function ownershipFormat(kind: string, operation: string) {
  const block = ownershipSource.match(
    new RegExp(`${kind}: \\{([\\s\\S]*?)\\n  \\}`)
  )?.[1];
  const value = block?.match(
    new RegExp(`${operation}: \\x60([^\\x60]+)\\x60`)
  )?.[1];
  if (!value) {
    return refuse();
  }
  return value
    .replaceAll("${PROJECT_LABEL}", "com.docker.compose.project")
    .replaceAll("${PREFIX}", "io.hack.native-config");
}
const appOwnership = (await has("app-ownership.json"))
  ? ((await Bun.file(`${root}/app-ownership.json`).json()) as {
      project: string;
      instance: string;
      owner: string;
      generation: string;
    })
  : null;
if (
  ["container", "volume", "network"].includes(args[0] ?? "") &&
  args[1] === "ls" &&
  same(args, [
    args[0],
    "ls",
    ...(args[0] === "container" ? ["--all"] : []),
    ...(args[0] === "volume" ? [] : ["--no-trunc"]),
    "--format",
    ownershipFormat(args[0] ?? "", "list"),
  ])
) {
  if (args[0] === "container" && appOwnership && (await has("app-present"))) {
    console.log(
      JSON.stringify({
        id: "f".repeat(64),
        name: `${appOwnership.project}-reader-1`,
        project: appOwnership.project,
      })
    );
  }
  process.exit(0);
}
if (
  same(args, [
    "container",
    "inspect",
    "--format",
    ownershipFormat("container", "inspect"),
    "f".repeat(64),
  ]) &&
  appOwnership &&
  (await has("app-present"))
) {
  console.log(
    JSON.stringify({
      id: "f".repeat(64),
      name: `/${appOwnership.project}-reader-1`,
      project: appOwnership.project,
      version: "1",
      instance: appOwnership.instance,
      owner: appOwnership.owner,
      generation: appOwnership.generation,
      service: "reader",
      oneoff: "False",
      state: "running",
      exitCode: 0,
      health: null,
      networks: {},
    })
  );
  process.exit(0);
}
if (same(args, ["info", "--format", "{{json .ID}}"])) {
  console.log(JSON.stringify("synthetic-vm-file-engine:1"));
  process.exit(0);
}
if (args[0] === "synthetic-lifetime") {
  if (
    args.length !== 2 ||
    !["complete", "held-pipe", "closed-pipe", "overflow", "hold"].includes(
      args[1] ?? ""
    )
  ) {
    refuse();
  }
  await writeFile(`${root}/leader.json`, JSON.stringify({ pid: process.pid }));
  if (args[1] === "complete") {
    console.log("complete");
    process.exit(0);
  }
  if (args[1] === "closed-pipe") {
    const keeper = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        "setTimeout(()=>process.exit(0),1000)",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      }
    );
    await writeFile(`${root}/keeper.json`, JSON.stringify({ pid: keeper.pid }));
    process.exit(0);
  }
  if (args[1] === "held-pipe") {
    const keeper = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(98),3000);setInterval(()=>{},1000)",
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      }
    );
    await writeFile(`${root}/keeper.json`, JSON.stringify({ pid: keeper.pid }));
    process.exit(0);
  }
  if (args[1] === "overflow") {
    try {
      await Bun.write(Bun.stdout, Buffer.alloc(3 * 1024 * 1024));
    } catch {
      /* Keep the owned leader until cancellation. */
    }
  }
  setTimeout(() => process.exit(98), 3000);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (args[0] === "synthetic-program") {
  exact(["synthetic-program", `${root}/program.mjs`]);
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", `${root}/program.mjs`],
    {
      cwd: root,
      stdin: Buffer.from(await Bun.stdin.arrayBuffer()),
      stdout: "inherit",
      stderr: "inherit",
      env: { PATH: "/usr/bin:/bin" },
    }
  );
  process.exit(await child.exited);
}
if (args[0] === "image") {
  exact(["image", "inspect", "--format", VM_FILE_IMAGE_FORMAT, args[4]]);
  if (!["oven/bun:1.4.2-slim", "synthetic/reader:1"].includes(args[4] ?? "")) {
    refuse();
  }
  console.log(
    JSON.stringify({
      id: args[4] === "oven/bun:1.4.2-slim" ? helper : app,
      user: (await has("named-user")) ? "named" : "",
      volumes: null,
      labels:
        args[4] === "oven/bun:1.4.2-slim"
          ? (await has("image-label-collision"))
            ? { "io.hack.native-file.role": "foreign" }
            : { "org.opencontainers.image.title": "Bun synthetic" }
          : null,
    })
  );
  process.exit(0);
}
if (same(args, ["volume", "ls", "--format", "{{json .Name}}"])) {
  if (state.volume) {
    console.log(JSON.stringify(state.volume.name));
  }
  process.exit(0);
}
if (args[0] === "volume" && args[1] === "create") {
  const name = args.at(-1) ?? refuse(),
    labels: Record<string, string> = {};
  for (let i = 4; i < args.length - 1; i += 2) {
    if (args[i] !== "--label") {
      refuse();
    }
    const value = args[i + 1] ?? refuse(),
      split = value.indexOf("=");
    labels[value.slice(0, split)] = value.slice(split + 1);
  }
  exact([
    "volume",
    "create",
    "--driver",
    "local",
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    name,
  ]);
  if (state.volume) {
    refuse();
  }
  state.volume = {
    name,
    driver: "local",
    scope: "local",
    created: "2026-10-09T00:00:00Z",
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    labels,
    options: null,
  };
  await save();
  console.log(name);
  process.exit(0);
}
if (args[0] === "volume" && args[1] === "inspect") {
  if (!state.volume) {
    refuse();
  }
  exact(["volume", "inspect", "--format", formats.volume, state.volume.name]);
  console.log(
    JSON.stringify({
      ...state.volume,
      ...((await has("birth-drift")) ||
      ((await has("retirement-volume-drift")) &&
        !state.containers["d".repeat(64)])
        ? { created: "2026-10-09T00:01:00Z" }
        : {}),
    })
  );
  process.exit(0);
}
if (args[0] === "container" && args[1] === "create") {
  const role =
    args.at(-1) === programs.writer
      ? "writer"
      : args.at(-1) === programs.observer
        ? "observer"
        : refuse();
  if (!state.volume) {
    refuse();
  }
  const labels: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label") {
      const value = args[++i] ?? refuse(),
        split = value.indexOf("=");
      labels[value.slice(0, split)] = value.slice(split + 1);
    }
  }
  const name = `${state.volume.name}-${role}`,
    caps =
      role === "writer"
        ? ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]
        : ["DAC_OVERRIDE", "SETGID", "SETUID"];
  if (role === "observer" && !state.facts) {
    refuse();
  }
  const facts = state.facts;
  const expectedMounts = [
    "type=volume,source=" +
      state.volume.name +
      ",target=/material,volume-nocopy" +
      (role === "observer" ? ",readonly" : ""),
    ...(role === "observer" && facts
      ? facts.members.map(
          (row) =>
            "type=bind,source=" +
            state.volume?.mountpoint +
            "/" +
            row.id +
            ",target=/projection/" +
            row.id +
            ",readonly"
        )
      : []),
  ];
  exact([
    "container",
    "create",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--user",
    "0:0",
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    ...caps.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    ...expectedMounts.flatMap((m) => ["--mount", m]),
    "--entrypoint",
    "/usr/local/bin/bun",
    "--interactive",
    helper,
    "-e",
    programs[role],
  ]);
  const id = (role === "writer" ? "c" : "d").repeat(64);
  const observedCaps = (await has("prefixed-capabilities"))
    ? caps.map((cap) => `CAP_${cap}`)
    : [...caps];
  if (await has("extra-capability")) {
    observedCaps.push("CAP_SYS_ADMIN");
  }
  if (await has("duplicate-capability")) {
    observedCaps[1] = observedCaps[0] ?? refuse();
  }
  if (await has("alias-duplicate-capability")) {
    observedCaps[1] = `CAP_${caps[0]}`;
  }
  if (await has("wrong-capability")) {
    observedCaps[0] = "CAP_DAC_READ_SEARCH";
  }
  if (await has("repeated-prefix-capability")) {
    observedCaps[0] = "CAP_CAP_CHOWN";
  }
  state.containers[id] = {
    id,
    name: `/${name}`,
    created: "2026-10-09T00:00:00Z",
    image: helper,
    labels: { "org.opencontainers.image.title": "Bun synthetic", ...labels },
    entrypoint: ["/usr/local/bin/bun"],
    command: ["-e", programs[role]],
    user: "0:0",
    openStdin: true,
    tty: false,
    network: "none",
    ports: null,
    restart: { Name: "no", MaximumRetryCount: 0 },
    readonly: true,
    privileged: false,
    capAdd: observedCaps,
    capDrop: ["ALL"],
    security: (await has("wrong-helper-security"))
      ? ["no-new-privileges=false"]
      : ["no-new-privileges"],
    autoRemove: false,
    mounts: [
      {
        Type: "volume",
        Name: state.volume.name,
        Source: state.volume.mountpoint,
        Destination: "/material",
        RW: role === "writer",
      },
      ...(role === "observer" && facts
        ? facts.members.map((row) => ({
            Type: "bind",
            Source: `${state.volume?.mountpoint}/${row.id}`,
            Destination: `/projection/${row.id}`,
            RW: false,
          }))
        : []),
    ].reverse(),
    running: false,
    status: "created",
    exitCode: 0,
    restarts: 0,
    execs: null,
  };
  await save();
  console.log(id);
  process.exit(0);
}
if (
  same(args, [
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--format",
    "{{json .ID}}",
  ])
) {
  if ((await has("app-present")) && state.facts) {
    console.log(JSON.stringify("f".repeat(64)));
  }
  for (const id of Object.keys(state.containers)) {
    console.log(JSON.stringify(id));
  }
  if ((await has("foreign-consumer")) && state.volume) {
    console.log(JSON.stringify("e".repeat(64)));
  }
  process.exit(0);
}
if (args[0] === "container" && args[1] === "inspect") {
  if (
    args[2] === "--format" &&
    args[3] === '{"id":{{json .Id}},"mounts":{{json .Mounts}}}'
  ) {
    if (args.length < 5 || args.length > 132) {
      refuse();
    }
    for (const id of args.slice(4)) {
      if (
        id === "f".repeat(64) &&
        (await has("app-present")) &&
        state.facts &&
        state.volume
      ) {
        console.log(
          JSON.stringify({
            id,
            mounts: state.facts.members.map((member) => ({
              Type: "bind",
              Source: `${state.volume?.mountpoint}/${member.id}`,
              Destination: member.target,
              RW: false,
            })),
          })
        );
        continue;
      }
      const row = state.containers[id];
      if (!row) {
        refuse();
      }
      console.log(JSON.stringify({ id, mounts: row.mounts }));
    }
    process.exit(0);
  }
  const id = args[4] ?? refuse();
  if (args.length !== 5 || args[2] !== "--format") {
    refuse();
  }
  const row = state.containers[id];
  if (
    id === "f".repeat(64) &&
    (await has("app-present")) &&
    state.volume &&
    state.facts
  ) {
    exact([
      "container",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},"mounts":{{json .Mounts}}}',
      id,
    ]);
    console.log(
      JSON.stringify({
        id,
        image: app,
        user: "",
        mounts: state.facts.members.map((member) => ({
          Type: "bind",
          Source: `${state.volume?.mountpoint}/${member.id}`,
          Destination: member.target,
          RW: false,
        })),
      })
    );
    process.exit(0);
  }
  if (id === "e".repeat(64) && (await has("foreign-consumer"))) {
    exact([
      "container",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},"mounts":{{json .Mounts}}}',
      id,
    ]);
    console.log(
      JSON.stringify({
        id,
        image: app,
        user: "",
        mounts: [
          {
            Type: "bind",
            Source: "/var/lib/docker/volumes",
            Destination: "/foreign",
            RW: false,
          },
        ],
      })
    );
    process.exit(0);
  }
  if (!row) {
    refuse();
  }
  if (args[3] === formats.container) {
    console.log(
      JSON.stringify({
        ...row,
        ...((await has("label-drift")) && id === "d".repeat(64)
          ? {
              labels: {
                ...row.labels,
                "org.opencontainers.image.title": "changed",
              },
            }
          : {}),
        ...((await has("observer-drift")) && id === "d".repeat(64)
          ? { image: `sha256:${"f".repeat(64)}` }
          : {}),
      })
    );
  } else if (
    args[3] ===
    '{"id":{{json .Id}},"image":{{json .Image}},"user":{{json .Config.User}},"mounts":{{json .Mounts}}}'
  ) {
    console.log(
      JSON.stringify({
        id,
        image: row.image,
        user: row.user,
        mounts: row.mounts,
      })
    );
  } else {
    refuse();
  }
  process.exit(0);
}
if (args[0] === "container" && args[1] === "start") {
  const id = args.at(-1) ?? refuse(),
    row = state.containers[id];
  if (!row) {
    refuse();
  }
  if (id === "c".repeat(64)) {
    exact(["container", "start", "--attach", "--interactive", id]);
    if (await has("writer-unknown")) {
      process.exit(61);
    }
    const input = JSON.parse(await Bun.stdin.text()) as {
      token: string;
      members: {
        id: string;
        workload: string;
        target: string;
        mode: "0444" | "0400" | "0600";
        uid: number;
        gid: number;
        bytes: string;
      }[];
    };
    const identity = (
      size: number,
      mode: number,
      uid: number,
      gid: number,
      ino: number
    ) => ({ dev: "1", ino: String(ino), ctime: "123", size, mode, uid, gid });
    const wrongMode = await has("wrong-mode");
    state.facts = {
      version: 1,
      token: input.token,
      root: identity(4096, 457, 0, 0, 1),
      witness: identity(32, 256, 0, 0, 2),
      members: input.members.map((m, index) => ({
        id: m.id,
        workload: m.workload,
        target: m.target,
        mode: m.mode,
        uid: m.uid,
        gid: m.gid,
        digest: digest(Buffer.from(m.bytes, "base64")),
        file: identity(
          Buffer.from(m.bytes, "base64").length,
          wrongMode ? 420 : Number.parseInt(m.mode, 8),
          m.uid,
          m.gid,
          index + 3
        ),
      })),
    };
    row.status = "exited";
    row.running = false;
    await save();
    console.log(JSON.stringify(state.facts));
    process.exit(0);
  }
  exact(["container", "start", id]);
  row.running = true;
  row.status = "running";
  await save();
  process.exit(0);
}
if (args[0] === "container" && args[1] === "exec") {
  const id = "d".repeat(64);
  exact([
    "container",
    "exec",
    "--interactive",
    id,
    "/usr/local/bin/bun",
    "-e",
    VM_FILE_VERIFY_PROGRAM,
  ]);
  if (!state.containers[id]?.running) {
    refuse();
  }
  if (await has("verify-unknown")) {
    process.exit(61);
  }
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (!same(input, state.facts)) {
    refuse();
  }
  console.log(JSON.stringify(input));
  process.exit(0);
}
if (args[0] === "container" && args[1] === "stop") {
  const id = "d".repeat(64);
  exact(["container", "stop", "--time", "2", id]);
  if (!state.containers[id]?.running) {
    refuse();
  }
  state.containers[id].running = false;
  state.containers[id].status = "exited";
  await save();
  console.log(id);
  process.exit(0);
}
if (args[0] === "container" && args[1] === "rm") {
  const id = args[2] ?? refuse();
  exact(["container", "rm", id]);
  if (!state.containers[id] || state.containers[id].running) {
    refuse();
  }
  delete state.containers[id];
  await save();
  console.log(id);
  process.exit(0);
}
if (args[0] === "volume" && args[1] === "rm") {
  exact(["volume", "rm", state.volume?.name]);
  if (Object.keys(state.containers).length || (await has("foreign-consumer"))) {
    refuse();
  }
  state.volume = null;
  await save();
  process.exit(0);
}
refuse();
