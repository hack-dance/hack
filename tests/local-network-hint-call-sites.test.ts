import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  composeDoctorBrowserHintTargets,
  nativeDoctorBrowserHintTargets,
  reportDoctorResults,
} from "../src/commands/doctor.ts";
import {
  createLocalNetworkHintEmitter,
  LOCAL_NETWORK_HINT_MESSAGE,
} from "../src/lib/local-network-hint.ts";
import { projectNameFixture } from "./helpers/project-name-fixture.ts";

/*
 * Each command that prints or opens a browser-facing origin must show the
 * macOS Local Network hint once for a `.local` host and never otherwise.
 *
 * CLI cases run the source CLI with `process.platform` preloaded as darwin,
 * so the hint path runs on any host. PATH holds only stub `open` and
 * `docker` executables plus system directories: nothing launches a browser
 * or reaches Docker, and HOME/state live in a temporary fixture.
 */

const LOCAL_HOST = "name-fixture.hack.local";
const PUBLIC_HOST = "name-fixture.hack.gy";
const CLI = resolve(import.meta.dir, "../index.ts");
const DARWIN_PRELOAD = resolve(
  import.meta.dir,
  "helpers/darwin-platform-preload.ts"
);

let cleanupRoot: string | null = null;

afterEach(async () => {
  if (cleanupRoot) {
    await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = null;
  }
});

function countHints(text: string): number {
  return text.split(LOCAL_NETWORK_HINT_MESSAGE).length - 1;
}

async function writeStub(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

/** Runs the source CLI as darwin against a registered `my-app` project. */
async function runAsDarwin(opts: {
  readonly devHost: string;
  readonly args: readonly string[];
}) {
  const fixture = await projectNameFixture();
  cleanupRoot = fixture.root;
  const target = await fixture.createProject("app", "my-app");
  await writeFile(
    target.project.configFile,
    JSON.stringify({ name: "my-app", dev_host: opts.devHost })
  );
  await fixture.writeRegistry([{ ...target.entry, devHost: opts.devHost }]);

  const tools = join(fixture.root, "tools");
  await mkdir(tools);
  const openLog = join(fixture.root, "open.log");
  const dockerLog = join(fixture.root, "docker.log");
  await writeStub(join(tools, "open"), `printf '%s\\n' "$*" >> "${openLog}"`);
  await writeStub(
    join(tools, "docker"),
    `printf '%s\\n' "$*" >> "${dockerLog}"\nexit 1`
  );

  const child = Bun.spawn(
    [process.execPath, "--preload", DARWIN_PRELOAD, CLI, ...opts.args],
    {
      cwd: fixture.root,
      env: {
        ...fixture.env,
        PATH: `${tools}:/usr/bin:/bin`,
        DOCKER_HOST: `unix://${join(fixture.root, "no-docker.sock")}`,
        HACK_NO_INTERACTIVE: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const opened = await readFile(openLog, "utf8").catch(() => "");
  return { code, stdout, stderr, opened };
}

const CLI_CASES = [
  {
    label: "hack open",
    args: ["open", "--prefer", "dev", "--project", "my-app"],
    opensBrowser: true,
  },
  {
    label: "hack branch open",
    args: [
      "branch",
      "open",
      "feature-x",
      "--prefer",
      "dev",
      "--project",
      "my-app",
    ],
    opensBrowser: true,
  },
  { label: "hack projects", args: ["projects"], opensBrowser: false },
  { label: "hack status", args: ["status"], opensBrowser: false },
] as const;

for (const testCase of CLI_CASES) {
  test(`${testCase.label} hints once for a .local host on macOS`, async () => {
    const result = await runAsDarwin({
      devHost: LOCAL_HOST,
      args: testCase.args,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(countHints(result.stderr), result.stderr).toBe(1);
    expect(result.stdout).not.toContain("Local Network");
    if (testCase.opensBrowser) {
      expect(result.opened).toContain(LOCAL_HOST);
      expect(result.opened.trim().split("\n")).toHaveLength(1);
    } else {
      expect(result.stdout).toContain(LOCAL_HOST);
      expect(result.opened).toBe("");
    }
  }, 20_000);

  test(`${testCase.label} does not hint for a non-.local host`, async () => {
    const result = await runAsDarwin({
      devHost: PUBLIC_HOST,
      args: testCase.args,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(countHints(result.stderr)).toBe(0);
    if (testCase.opensBrowser) {
      expect(result.opened).toContain(PUBLIC_HOST);
    } else {
      expect(result.stdout).toContain(PUBLIC_HOST);
    }
  }, 20_000);
}

// Doctor runs host probes (Docker, resolver, keychain, curl), so its hint
// wiring is checked through the shared report step and each path's targets.

function captureHints() {
  const lines: string[] = [];
  const emitter = createLocalNetworkHintEmitter({
    platform: "darwin",
    write: (line) => {
      lines.push(line);
    },
  });
  return {
    lines,
    noteHint: (targets: readonly string[]) => emitter.note(targets),
  };
}

async function report(opts: {
  readonly json: boolean;
  readonly browserHintTargets: readonly string[];
}) {
  const hints = captureHints();
  const events: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => {
    events.push("stdout");
    return true;
  });
  try {
    const code = await reportDoctorResults({
      results: [
        { name: "bun", status: "ok", message: "fixture", durationMs: 0 },
      ],
      hasError: false,
      json: opts.json,
      browserHintTargets: opts.browserHintTargets,
      renderHuman: async () => {
        events.push("render");
      },
      noteHint: (targets) => {
        const shown = hints.noteHint(targets);
        if (shown) {
          events.push("hint");
        }
        return shown;
      },
    });
    return { code, events, lines: hints.lines };
  } finally {
    stdout.mockRestore();
  }
}

const DOCTOR_PATHS = [
  {
    label: "compose doctor",
    local: composeDoctorBrowserHintTargets({
      url: null,
      defaultDomain: "hack.local",
    }),
    other: composeDoctorBrowserHintTargets({
      url: null,
      defaultDomain: "hack",
    }),
  },
  {
    label: "compose doctor --browser-url",
    local: composeDoctorBrowserHintTargets({
      url: "https://app.hack.local/",
      defaultDomain: "hack",
    }),
    other: composeDoctorBrowserHintTargets({
      url: "https://app.hack/",
      defaultDomain: "hack.local",
    }),
  },
  {
    label: "native doctor --browser-url",
    local: nativeDoctorBrowserHintTargets("https://app.hack.local/"),
    other: nativeDoctorBrowserHintTargets("https://app.hack/"),
  },
] as const;

for (const path of DOCTOR_PATHS) {
  for (const json of [false, true]) {
    const mode = json ? "--json" : "human";
    test(`${path.label} (${mode}) hints once for a .local target`, async () => {
      const result = await report({ json, browserHintTargets: path.local });
      expect(result.code).toBe(json ? 0 : null);
      expect(result.lines).toEqual([`${LOCAL_NETWORK_HINT_MESSAGE}\n`]);
      // The hint follows the report, so JSON output is complete before it.
      expect(result.events.at(-1)).toBe("hint");
      expect(result.events).toContain(json ? "stdout" : "render");
    });

    test(`${path.label} (${mode}) does not hint for a non-.local target`, async () => {
      const result = await report({ json, browserHintTargets: path.other });
      expect(result.lines).toEqual([]);
      expect(result.events).toContain(json ? "stdout" : "render");
    });
  }
}

test("native doctor without --browser-url names no browser target", async () => {
  expect(nativeDoctorBrowserHintTargets(null)).toEqual([]);
  const result = await report({
    json: false,
    browserHintTargets: nativeDoctorBrowserHintTargets(null),
  });
  expect(result.lines).toEqual([]);
});
