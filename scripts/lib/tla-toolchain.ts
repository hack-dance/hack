import { link, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { TlaResult } from "./tla-result.ts";

/** Official v1.7.4 asset 184694200, checked against the retained pin on 2026-10-23. */
export const TLA_TOOL = {
  version: "1.7.4",
  url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  banner: "TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)",
} as const;

export const TLA_TIMEOUT_MS = 120_000;
export const TLA_JAVA_FLAGS = [
  "-Xmx512m",
  "-XX:ActiveProcessorCount=1",
  "-XX:+UseParallelGC",
  "-XX:-UsePerfData",
] as const;

export function verifyTlaChecksum(bytes: ArrayBuffer): void {
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== TLA_TOOL.sha256) {
    throw new Error(
      `TLA+ jar checksum mismatch: expected ${TLA_TOOL.sha256}, got ${actual}.`
    );
  }
}

export async function resolveTlaJar(opts: {
  readonly root: string;
  readonly override?: string;
  readonly download: boolean;
}): Promise<string> {
  const jar = resolve(
    opts.root,
    opts.override ?? `.cache/tlaplus/tla2tools-${TLA_TOOL.version}.jar`
  );
  if (!(await Bun.file(jar).exists())) {
    if (opts.override || !opts.download) {
      throw new Error(
        `Missing pinned TLA+ jar: ${jar}. Set TLA2TOOLS_JAR or rerun with --download.`
      );
    }
    await downloadTlaJar(jar);
  }
  verifyTlaChecksum(await Bun.file(jar).arrayBuffer());
  return jar;
}

async function downloadTlaJar(jar: string): Promise<void> {
  const response = await fetch(TLA_TOOL.url, {
    signal: AbortSignal.timeout(TLA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`TLA+ download failed: HTTP ${response.status}.`);
  }
  const bytes = await response.arrayBuffer();
  verifyTlaChecksum(bytes);
  await mkdir(dirname(jar), { recursive: true });
  const staging = await mkdtemp(resolve(dirname(jar), ".download-"));
  try {
    const downloaded = resolve(staging, "tla2tools.jar");
    await Bun.write(downloaded, bytes);
    try {
      await link(downloaded, jar);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runTlaProcess(opts: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}): Promise<TlaResult> {
  const child = Bun.spawn([...opts.command], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? TLA_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    exitCode,
    output: `${stdout}\n${stderr}`,
    failed: child.signalCode !== null,
  };
}

export async function withTlaScratch<T>(
  run: (scratch: string) => Promise<T>
): Promise<T> {
  const scratch = await mkdtemp(resolve(tmpdir(), "hack-tla-"));
  try {
    return await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The pinned TLC reports unnamed temporal failures. Its own config parser verifies
 * that exactly one requested check is enabled; its message recorder names that
 * property only when TLC emits the actual temporal-violation event. Java source
 * launching keeps this adapter disposable and requires no compiled artifact.
 * v1.7.4 generates no TE files unless -generateSpecTE is explicitly supplied.
 */
export const TLA_LAUNCHER = `
import java.util.Arrays;
import tlc2.TLC;
import tlc2.output.EC;
import tlc2.output.MP;
import tlc2.output.MPRecorder;
import tlc2.tool.impl.ModelConfig;
import tlc2.util.Vect;
import util.SimpleFilenameToStream;

class CheckedTlc {
  public static void main(String[] args) throws Exception {
    String kind = args[0];
    String property = args[1];
    ModelConfig config = new ModelConfig(args[2], new SimpleFilenameToStream());
    config.parse();
    Vect selected = kind.equals("temporal") ? config.getProperties() : config.getInvariants();
    Vect others = kind.equals("temporal") ? config.getInvariants() : config.getProperties();
    if (selected.size() != 1 || others.size() != 0 || !property.equals(selected.elementAt(0))) {
      throw new IllegalArgumentException("Config must enable only " + kind + " " + property);
    }
    MP.setRecorder(new MPRecorder() {
      @Override public void record(int code, Object... objects) {
        if (code == EC.TLC_TEMPORAL_PROPERTY_VIOLATED && kind.equals("temporal")) {
          System.out.println("Temporal property " + property + " was violated.");
        }
      }
    });
    TLC.main(Arrays.copyOfRange(args, 3, args.length));
  }
}
`;
