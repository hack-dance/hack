import { expect, test } from "bun:test";
import { rawCleanupInstruction } from "../src/lib/data-backup-cleanup-instruction.ts";

/**
 * The raw recovery command for a container whose create Hack could not
 * reconcile must target the engine the data command used, and must never
 * print a managed value that could be a credential.
 */
const NONCE = "0123456789abcdef0123456789abcdef";
const FILTER = `--filter label=io.hack.data-backup.nonce=${NONCE}`;

test("without a managed engine selection the command targets the caller's engine", () => {
  const { command, sentence } = rawCleanupInstruction({
    nonce: NONCE,
    engine: { host: null, context: null },
    redactValues: [],
  });
  expect(command).toBe(`docker ps -aq ${FILTER} | xargs -r docker rm -f`);
  expect(sentence).toBe(`\`${command}\``);
});

test("a managed context is carried on both sides of the pipe", () => {
  const { command } = rawCleanupInstruction({
    nonce: NONCE,
    engine: { host: null, context: "build-box" },
    redactValues: ["build-box"],
  });
  expect(command).toBe(
    `docker --context build-box ps -aq ${FILTER} | xargs -r docker --context build-box rm -f`
  );
});

test("a context name carrying another managed value has it redacted", () => {
  // Not a credential: a stand-in for a managed secret.
  const managed = "ctx-managed-canary-91ab";
  const { command } = rawCleanupInstruction({
    nonce: NONCE,
    engine: { host: null, context: `team-${managed}` },
    redactValues: [`team-${managed}`, managed],
  });
  expect(command).not.toContain(managed);
  expect(command).toContain("--context team-[REDACTED]");
});

test("a credential-free managed DOCKER_HOST is carried on both sides of the pipe", () => {
  const host = "tcp://10.0.0.5:2376";
  const { command } = rawCleanupInstruction({
    nonce: NONCE,
    engine: { host, context: null },
    redactValues: [host],
  });
  expect(command).toBe(
    `DOCKER_HOST=${host} docker ps -aq ${FILTER} | DOCKER_HOST=${host} xargs -r docker rm -f`
  );
});

test("a managed DOCKER_HOST with userinfo, a query or another managed value is never printed", () => {
  // Not credentials: recognizable stand-ins.
  for (const [host, others] of [
    ["ssh://deploy:hunter2-canary@build.example:22", []],
    ["tcp://10.0.0.5:2376?token=canary-token-77", []],
    ["unix:///run/user/canary-secret-55/docker.sock", ["canary-secret-55"]],
  ] as const) {
    const { command, sentence } = rawCleanupInstruction({
      nonce: NONCE,
      engine: { host, context: null },
      redactValues: [host, ...others],
    });
    expect({ host, command }).toEqual({
      host,
      command: `docker ps -aq ${FILTER} | xargs -r docker rm -f`,
    });
    expect(sentence).toContain("with your managed DOCKER_HOST");
    expect(sentence).not.toContain(host);
    expect(sentence).not.toContain("canary");
  }
});
