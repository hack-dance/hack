import { expect, test } from "bun:test"

import { ExtensionManager } from "../src/control-plane/extensions/manager.ts"
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts"

import type { Logger } from "../src/ui/logger.ts"
import type { ExtensionDefinition } from "../src/control-plane/extensions/types.ts"

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  step: () => {}
}

test("ExtensionManager resolves namespace overrides and enabled flag", async () => {
  const defaults = (await readControlPlaneConfig({})).config
  const config = {
    ...defaults,
    extensions: {
      ...defaults.extensions,
      "demo.ext": { enabled: true, cliNamespace: "alpha", config: {} }
    }
  }

  const manager = new ExtensionManager({ config, logger: silentLogger })
  const ext: ExtensionDefinition = {
    manifest: {
      id: "demo.ext",
      version: "0.1.0",
      scopes: ["global"],
      cliNamespace: "demo"
    },
    commands: []
  }

  manager.registerExtension({ extension: ext })
  const resolved = manager.listExtensions()[0]

  expect(resolved?.namespace).toBe("alpha")
  expect(resolved?.enabled).toBe(true)
})

test("ExtensionManager warns and falls back on namespace collisions", async () => {
  const defaults = (await readControlPlaneConfig({})).config
  const config = {
    ...defaults,
    extensions: {
      "ext.a": { enabled: true, config: {} },
      "ext.b": { enabled: true, config: {} }
    }
  }

  const manager = new ExtensionManager({ config, logger: silentLogger })

  const extA: ExtensionDefinition = {
    manifest: {
      id: "ext.a",
      version: "0.1.0",
      scopes: ["global"],
      cliNamespace: "tickets"
    },
    commands: []
  }

  const extB: ExtensionDefinition = {
    manifest: {
      id: "ext.b",
      version: "0.1.0",
      scopes: ["global"],
      cliNamespace: "tickets"
    },
    commands: []
  }

  manager.registerExtension({ extension: extA })
  manager.registerExtension({ extension: extB })

  const resolved = manager.listExtensions()
  expect(resolved[0]?.namespace).toBe("tickets")
  expect(resolved[1]?.namespace).not.toBe("tickets")
  expect(resolved[1]?.namespace?.startsWith("tickets.")).toBe(true)
  expect(manager.getWarnings().length).toBe(1)
})

test("ExtensionManager resolves command ids", async () => {
  const defaults = (await readControlPlaneConfig({})).config
  const config = {
    ...defaults,
    extensions: {
      "ext.jobs": { enabled: true, config: {} }
    }
  }

  const manager = new ExtensionManager({ config, logger: silentLogger })
  const ext: ExtensionDefinition = {
    manifest: {
      id: "ext.jobs",
      version: "0.1.0",
      scopes: ["global"],
      cliNamespace: "jobs"
    },
    commands: [
      {
        name: "run",
        summary: "Run a job",
        scope: "global",
        handler: async () => 0
      }
    ]
  }

  manager.registerExtension({ extension: ext })
  const resolved = manager.resolveCommandId({ commandId: "ext.jobs:run" })
  expect(resolved?.namespace).toBe("jobs")
  expect(resolved?.commandName).toBe("run")
})

test("ExtensionManager avoids reserved namespaces", async () => {
  const defaults = (await readControlPlaneConfig({})).config
  const config = {
    ...defaults,
    extensions: {
      "ext.reserved": { enabled: true, config: {} }
    }
  }

  const manager = new ExtensionManager({ config, logger: silentLogger })
  manager.registerExtension({
    extension: {
      manifest: {
        id: "ext.reserved",
        version: "0.1.0",
        scopes: ["global"],
        cliNamespace: "x"
      },
      commands: []
    }
  })

  const resolved = manager.listExtensions()[0]
  expect(resolved?.namespace).not.toBe("x")
  expect(resolved?.namespace?.startsWith("x.")).toBe(true)
})
