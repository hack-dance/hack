import qrcode from "qrcode"

import { display } from "./display.ts"
import { gumConfirm, isGumAvailable } from "./gum.ts"
import { logger } from "./logger.ts"
import { isTty } from "./terminal.ts"

export function buildGatewayQrPayload(opts: {
  readonly baseUrl: string
  readonly token: string
  readonly projectId?: string
  readonly projectName?: string
}): string {
  const payload = {
    type: "hack.gateway",
    baseUrl: normalizeGatewayUrl(opts.baseUrl),
    token: opts.token,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.projectName ? { projectName: opts.projectName } : {})
  }
  return JSON.stringify(payload)
}

export function buildSshQrPayload(opts: {
  readonly host: string
  readonly user?: string
  readonly port?: number
}): string {
  const userSegment = opts.user ? `${opts.user}@` : ""
  const portSegment = opts.port ? `:${opts.port}` : ""
  return `ssh://${userSegment}${opts.host}${portSegment}`
}

export async function renderQrPayload(opts: {
  readonly label: string
  readonly payload: string
  readonly sensitive: boolean
  readonly yes: boolean
}): Promise<boolean> {
  if (opts.sensitive) {
    const ok = await confirmSensitiveQr({
      label: opts.label,
      yes: opts.yes
    })
    if (!ok) return false
  }

  const rendered = await renderQrWithQrcode({ payload: opts.payload })
  if (rendered.ok) {
    await display.panel({
      title: `${opts.label} QR`,
      tone: "info",
      lines: ["Scan this QR with your device.", "Keep it private if it includes a token."]
    })
    const output = rendered.output.endsWith("\n") ? rendered.output : `${rendered.output}\n`
    process.stdout.write(output)
    return true
  }

  await display.panel({
    title: `${opts.label} QR payload`,
    tone: "info",
    lines: [opts.payload, "Unable to render a QR code; printing payload instead."]
  })
  return true
}

function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed
}

async function confirmSensitiveQr(opts: {
  readonly label: string
  readonly yes: boolean
}): Promise<boolean> {
  if (opts.yes) return true
  if (!isTty() || !isGumAvailable()) {
    logger.error({
      message: `Refusing to print ${opts.label} QR in non-interactive mode. Re-run with --yes.`
    })
    return false
  }
  const confirmed = await gumConfirm({
    prompt: `${opts.label} QR includes a token. Print it?`,
    default: false
  })
  return confirmed.ok && confirmed.value
}

async function renderQrWithQrcode(opts: {
  readonly payload: string
}): Promise<{ readonly ok: true; readonly output: string } | { readonly ok: false }> {
  try {
    const output = await qrcode.toString(opts.payload, {
      type: "utf8",
      margin: 0,
      errorCorrectionLevel: "L"
    })
    return { ok: true, output }
  } catch {
    return { ok: false }
  }
}
