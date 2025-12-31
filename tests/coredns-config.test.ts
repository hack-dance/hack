import { expect, test } from "bun:test"

import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_NETWORK
} from "../src/constants.ts"
import { renderGlobalCaddyCompose, renderGlobalCoreDnsConfig } from "../src/templates.ts"

test("renderGlobalCoreDnsConfig uses template + fallthrough for static caddy ip", () => {
  const text = renderGlobalCoreDnsConfig({ useStaticCaddyIp: true })
  expect(text).toContain("template IN A")
  expect(text).toContain(`answer \"{{ .Name }} 30 IN A ${DEFAULT_CADDY_IP}\"`)
  expect(text).toContain("fallthrough")
  expect(text).toContain("forward . 127.0.0.11")
})

test("renderGlobalCoreDnsConfig uses rewrite for dynamic caddy ip", () => {
  const text = renderGlobalCoreDnsConfig()
  expect(text).toContain("rewrite name regex")
  expect(text).not.toContain("template IN A")
})

test("renderGlobalCaddyCompose pins caddy and coredns when requested", () => {
  const text = renderGlobalCaddyCompose({ useStaticCaddyIp: true, useStaticCoreDnsIp: true })
  expect(text).toContain(`name: ${DEFAULT_INGRESS_NETWORK}`)
  expect(text).toContain(`ipv4_address: ${DEFAULT_CADDY_IP}`)
  expect(text).toContain(`ipv4_address: ${DEFAULT_COREDNS_IP}`)
})
