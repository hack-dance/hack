import { expect, test } from "bun:test"

function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

test("log-pipe formats docker-compose prefixed lines from stdin", async () => {
  const input =
    ['api  | {"level":"warn","msg":"hello","foo":1}', "api  | plain text"].join("\n") + "\n"

  const proc = Bun.spawn(
    ["bun", "run", "index.ts", "log-pipe", "--format", "docker-compose", "--stream", "stdout"],
    {
      cwd: process.cwd(),
      stdin: new Response(input).body,
      stdout: "pipe",
      stderr: "pipe"
    }
  )

  const exitCode = await proc.exited
  const stdoutText = await new Response(proc.stdout).text()
  const stderrText = await new Response(proc.stderr).text()

  expect(exitCode).toBe(0)
  expect(stderrText).toBe("")

  const lines = stripTrailingNewline(stdoutText).split("\n")
  expect(lines[0]).toBe("[WARN] [api] hello foo=1")
  expect(lines[1]).toBe("[api] plain text")
})

test("log-pipe --stream stderr forces ERROR level", async () => {
  const input = 'api  | {"level":"info","msg":"boom"}\n'
  const proc = Bun.spawn(
    ["bun", "run", "index.ts", "log-pipe", "--format", "docker-compose", "--stream", "stderr"],
    {
      cwd: process.cwd(),
      stdin: new Response(input).body,
      stdout: "pipe",
      stderr: "pipe"
    }
  )

  const exitCode = await proc.exited
  const stdoutText = await new Response(proc.stdout).text()
  const stderrText = await new Response(proc.stderr).text()

  expect(exitCode).toBe(0)
  expect(stdoutText).toBe("")
  expect(stripTrailingNewline(stderrText)).toBe("[ERROR] [api] boom")
})
