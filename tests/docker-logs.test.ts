import { expect, test } from "bun:test";

import { formatDockerComposeLogLineForTests } from "../src/ui/docker-logs.ts";

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

test("pretty log formats JSON payload with service prefix", () => {
  const out = formatDockerComposeLogLineForTests({
    line: 'caddy-1  | 2025-12-30T03:30:48.866961464Z {"level":"info","msg":"hello","foo":1}',
    stream: "stdout",
  });
  const plain = stripAnsi(out);
  expect(plain).toContain("[03:30:48.866] [INFO] [caddy-1] hello");
  expect(plain).toContain("foo=1");
});

test("pretty log formats non-JSON payload", () => {
  const out = formatDockerComposeLogLineForTests({
    line: "api  | 2025-12-30T03:30:48.000Z plain text",
    stream: "stdout",
  });
  const plain = stripAnsi(out);
  expect(plain).toBe("[03:30:48.000] [api] plain text");
});

test("stderr stream forces ERROR level", () => {
  const out = formatDockerComposeLogLineForTests({
    line: "api  | 2025-12-30T03:30:48Z boom",
    stream: "stderr",
  });
  const plain = stripAnsi(out);
  expect(plain.startsWith("[03:30:48] [ERROR] [api] boom")).toBe(true);
});

test("pretty log supports pino numeric levels", () => {
  const out = formatDockerComposeLogLineForTests({
    line: 'api  | 2025-12-30T03:30:48.866Z {"level":30,"msg":"hello","foo":1}',
    stream: "stdout",
  });
  const plain = stripAnsi(out);
  expect(plain).toContain("[03:30:48.866] [INFO] [api] hello");
  expect(plain).toContain("foo=1");
});
