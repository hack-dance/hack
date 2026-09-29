import { expect, test } from "bun:test";
import { createDependencyCacheProtocol } from "../src/lib/dependency-cache-protocol.ts";

const options = {
  volume: "deps",
  fingerprint: "a".repeat(16),
  scriptPath: "/hack-dependency-cache-install.sh",
};
function service() {
  return {
    entrypoint: [],
    command: ["bun", "install", "--frozen-lockfile"],
    volumes: ["deps:/app/node_modules"],
    labels: {
      "hack.dependencies.cache-protocol": "locked-v1",
      "hack.dependencies.cache-verify": '["bun","-e","process.exit(0)"]',
    },
  };
}

test("protocol is opt-in and does not replace installer argv", () => {
  expect(createDependencyCacheProtocol({ ...options, service: {} })).toBeNull();
  const declared = service();
  const result = createDependencyCacheProtocol({
    ...options,
    service: declared,
  });
  expect(result?.entrypoint).toEqual(["/bin/sh", options.scriptPath]);
  expect(result?.target).toBe("/app/node_modules");
  expect(declared.command).toEqual(["bun", "install", "--frozen-lockfile"]);
  expect(result?.script).toContain('"$@" || fail');
  expect(result?.script).toContain("until flock -n 9; do");
  expect(result?.script).toContain('[ "$waited" -lt 60 ] || fail');
  expect(result?.script).toContain("sleep 1 || fail");
  expect(result?.script).not.toContain("flock -w");
  expect(result?.script).toContain('expected | cmp -s - "$meta/ready"');
  expect(result?.script).toContain("phase waiting");
  expect(result?.script).toContain("phase installing");
  expect(result?.script).toContain("phase verifying");
  expect(result?.script).toContain("phase ready");
});

test("unsafe and ambiguous declarations are refused", () => {
  const base = service();
  for (const changed of [
    { ...base, entrypoint: undefined },
    { ...base, entrypoint: ["wrapper"] },
    { ...base, command: "bun install" },
    { ...base, command: [] },
    { ...base, volumes: ["deps:/app/node_modules:ro"] },
    { ...base, volumes: ["deps:relative"] },
    { ...base, volumes: ["deps:/app/../modules"] },
    { ...base, volumes: ["deps:/one", "deps:/two"] },
    {
      ...base,
      volumes: [{ type: "bind", source: "deps", target: "/modules" }],
    },
    {
      ...base,
      volumes: [
        {
          type: "volume",
          source: "deps",
          target: "/modules",
          volume: { subpath: "x" },
        },
      ],
    },
    {
      ...base,
      labels: { ...base.labels, "hack.dependencies.cache-verify": "[]" },
    },
    {
      ...base,
      labels: { ...base.labels, "hack.dependencies.cache-verify": "not json" },
    },
    {
      ...base,
      labels: { ...base.labels, "hack.dependencies.cache-protocol": "unknown" },
    },
  ]) {
    expect(() =>
      createDependencyCacheProtocol({ ...options, service: changed })
    ).toThrow("Invalid locked-v1");
  }
});

test("verification argv is shell quoted and generated script parses as POSIX shell", async () => {
  const declared = service();
  declared.labels["hack.dependencies.cache-verify"] = JSON.stringify([
    "/bin/echo",
    "a'b",
    "$(not-a-command)",
    "line\nnext",
  ]);
  const result = createDependencyCacheProtocol({
    ...options,
    service: declared,
  });
  expect(result).not.toBeNull();
  expect(result?.script).toContain("'a'\\''b'");
  expect(result?.script).toContain("'$(not-a-command)'");
  const child = Bun.spawn(["/bin/sh", "-n"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 2000,
  });
  child.stdin.write(result?.script ?? "invalid");
  child.stdin.end();
  expect(await child.exited).toBe(0);
});

test("long mount and list labels are accepted with fixed failure and no payload removal", () => {
  const base = service();
  const result = createDependencyCacheProtocol({
    ...options,
    service: {
      ...base,
      labels: Object.entries(base.labels).map(
        ([key, value]) => `${key}=${value}`
      ),
      volumes: [
        {
          type: "volume",
          source: "deps",
          target: "/modules",
          read_only: false,
        },
      ],
    },
  });
  expect(result?.target).toBe("/modules");
  expect(result?.script).toContain("for marker in attempt ready ready.pending");
  expect(result?.script).toContain("bump hack.dependencies.cache-generation");
  expect(result?.script).not.toContain("rm ");
  expect(result?.script.indexOf('"$@" || fail')).toBeLessThan(
    result?.script.indexOf('mv "$meta/ready.pending"') ?? 0
  );
});

test("command overrides refuse before cache or tool access without echoing argv", async () => {
  const result = createDependencyCacheProtocol({
    ...options,
    service: service(),
  });
  expect(result).not.toBeNull();
  for (const args of [
    [],
    ["bun", "install"],
    ["bun", "install", "--different-private-argument"],
    ["bun", "install", "--frozen-lockfile", "extra"],
  ]) {
    const child = Bun.spawn(["/bin/sh", "-s", "--", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/nonexistent" },
      timeout: 2000,
    });
    child.stdin.write(result?.script ?? "invalid");
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(64);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Dependency cache command override refused; use the declared initializer command.\n"
    );
  }
});

test("locked protocol children use clean environments and refuse declared environment inputs", () => {
  const base = service();
  for (const extra of [
    { environment: { TOKEN: "value" } },
    { environment: ["TOKEN"] },
    { env_file: ["vars.env"] },
  ]) {
    expect(() =>
      createDependencyCacheProtocol({
        ...options,
        service: { ...base, ...extra },
      })
    ).toThrow();
  }
  const generated = createDependencyCacheProtocol({
    ...options,
    service: { ...base, environment: {} },
  });
  expect(
    generated?.script.split(
      "env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/tmp"
    )
  ).toHaveLength(3);
  expect(generated?.script).toContain("command -v env");
  expect(generated?.script?.indexOf("export PATH")).toBeLessThan(
    generated?.script?.indexOf("command -v flock") ?? 0
  );
});

test("cache and script mounts cannot shadow reserved paths or nested payload mounts", () => {
  const base = service();
  for (const volumes of [
    ["deps:/etc/hack/ca"],
    ["deps:/etc/hack"],
    ["deps:/etc/hack/ca/child"],
    ["deps:/hack-dependency-cache-install.sh"],
    ["deps:/modules", "other:/modules/child"],
    ["deps:/modules", "other:/modules"],
    ["deps:/modules", "other:/hack-dependency-cache-install.sh"],
  ]) {
    expect(() =>
      createDependencyCacheProtocol({
        ...options,
        service: { ...base, volumes },
      })
    ).toThrow();
  }
  expect(
    createDependencyCacheProtocol({
      ...options,
      service: { ...base, volumes: ["deps:/app/node_modules", ".:/app:ro"] },
    })?.target
  ).toBe("/app/node_modules");
});
