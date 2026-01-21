import { fileURLToPath } from "node:url"

const testPath = fileURLToPath(new URL("../tests/gateway-e2e.test.ts", import.meta.url))
const command = [process.execPath, "test", testPath]
const cwd = process.env.HACK_GATEWAY_E2E_CWD?.trim() || process.cwd()
const proc = Bun.spawn({
  cmd: command,
  cwd,
  env: {
    ...process.env,
    HACK_GATEWAY_E2E: "1",
    HACK_GATEWAY_E2E_WRITE: process.env.HACK_GATEWAY_E2E_WRITE ?? "1"
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit"
})

const exitCode = await proc.exited
process.exit(exitCode)
