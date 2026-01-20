import { test as bunTest } from "bun:test"

const isGithubActions = process.env.GITHUB_ACTIONS === "true"
const isCi = process.env.CI === "true" || isGithubActions
const allowIntegration = process.env.HACK_TEST_INTEGRATION === "1"
const allowNetwork = process.env.HACK_TEST_NETWORK === "1"

const shouldRunIntegration = !isCi || allowIntegration
const shouldRunNetwork = !isCi || allowNetwork

type TestOptions = { timeout?: number }
type TestFn = () => void | Promise<unknown>
type ConditionalTest = {
  (name: string, fn: TestFn): void
  (name: string, options: TestOptions, fn: TestFn): void
}

function createConditionalTest(shouldRun: boolean): ConditionalTest {
  return (name: string, optionsOrFn: TestOptions | TestFn, maybeFn?: TestFn): void => {
    if (typeof optionsOrFn === "function") {
      if (shouldRun) {
        bunTest(name, optionsOrFn)
      } else {
        bunTest.skip(name, optionsOrFn)
      }
    } else {
      const fn = maybeFn as TestFn
      const timeout = optionsOrFn.timeout
      if (shouldRun) {
        bunTest(name, fn, timeout)
      } else {
        bunTest.skip(name, fn)
      }
    }
  }
}

const testIntegration = createConditionalTest(shouldRunIntegration)
const testNetwork = createConditionalTest(shouldRunNetwork)

export {
  allowIntegration,
  allowNetwork,
  isCi,
  isGithubActions,
  shouldRunIntegration,
  shouldRunNetwork,
  testIntegration,
  testNetwork
}
