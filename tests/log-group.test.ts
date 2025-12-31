import { expect, test } from "bun:test"

import { createStructuredLogGrouper } from "../src/ui/log-group.ts"

test("structured log grouper keeps multiline JSON together", () => {
  const out: string[] = []
  const grouper = createStructuredLogGrouper({
    write: text => out.push(text)
  })

  grouper.handleLine("svc-a | {")
  grouper.handleLine("svc-b | hello")
  grouper.handleLine('svc-a |   "foo": "bar"')
  grouper.handleLine("svc-b | world")
  grouper.handleLine("svc-a | }")

  grouper.flush()

  expect(out).toEqual([
    "svc-b | hello\n",
    "svc-b | world\n",
    'svc-a | {\nsvc-a |   "foo": "bar"\nsvc-a | }\n'
  ])
})
