import { expect, test } from "bun:test"

import { CLI_SPEC } from "../src/cli/spec.ts"
import {
  collectAllowedOptionNames,
  parseOptionsForCommand,
  parsePositionalsForCommand,
  resolveCommand
} from "../src/cli/command.ts"

test("resolveCommand finds nested subcommand and remaining positionals", () => {
  const resolved = resolveCommand(CLI_SPEC, ["global", "logs", "caddy"])
  expect(resolved.command?.name).toBe("logs")
  expect(resolved.path.map(c => c.name)).toEqual(["global", "logs"])
  expect(resolved.remainingPositionals).toEqual(["caddy"])
})

test("built-in options are always allowed for a command", () => {
  const resolved = resolveCommand(CLI_SPEC, ["global", "logs"])
  const allowed = collectAllowedOptionNames(CLI_SPEC, resolved.command)
  expect(allowed.has("help")).toBe(true)
  expect(allowed.has("version")).toBe(true)
})

test("parsePositionalsForCommand throws on extra args", () => {
  expect(() =>
    parsePositionalsForCommand([{ name: "service", required: false }], ["caddy", "extra"])
  ).toThrow("Unexpected arguments")
})

test("parseOptionsForCommand converts number options", () => {
  const opts = [
    {
      name: "tail",
      type: "number",
      long: "--tail",
      description: "Tail",
      valueHint: "<n>"
    },
    {
      name: "follow",
      type: "boolean",
      long: "--follow",
      description: "Follow"
    }
  ] as const

  const parsed = parseOptionsForCommand(opts, { tail: "10", follow: true })
  expect(parsed.tail).toBe(10)
  expect(parsed.follow).toBe(true)
})
