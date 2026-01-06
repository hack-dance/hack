import { verifyGatewayToken } from "./tokens.ts"

import type { GatewayTokenScope } from "./tokens.ts"

export type GatewayAuthResult =
  | { readonly ok: true; readonly tokenId: string; readonly scope: GatewayTokenScope }
  | { readonly ok: false; readonly reason: "missing" | "invalid" }

/**
 * Authenticate a gateway request using a bearer token.
 *
 * @param opts.rootDir - Daemon root directory.
 * @param opts.headers - Request headers.
 * @param opts.url - Request URL (optional, used for query token fallback).
 * @param opts.allowQueryToken - Allow token from query string when headers are unavailable.
 * @returns Authentication result with token id when valid.
 */
export async function authenticateGatewayRequest(opts: {
  readonly rootDir: string
  readonly headers: Headers
  readonly url?: URL
  readonly allowQueryToken?: boolean
}): Promise<GatewayAuthResult> {
  const token = extractGatewayToken({
    headers: opts.headers,
    url: opts.url,
    allowQueryToken: opts.allowQueryToken
  })
  if (!token) return { ok: false, reason: "missing" }

  const verified = await verifyGatewayToken({ rootDir: opts.rootDir, token })
  if (!verified) return { ok: false, reason: "invalid" }
  return { ok: true, tokenId: verified.id, scope: verified.scope }
}

function extractGatewayToken(opts: {
  readonly headers: Headers
  readonly url?: URL
  readonly allowQueryToken?: boolean
}): string | null {
  const auth = (opts.headers.get("authorization") ?? "").trim()
  if (auth.length > 0) {
    const match = auth.match(/^Bearer\s+(.+)$/i)
    if (match && match[1]) return match[1].trim()
  }

  const alt = (opts.headers.get("x-hack-token") ?? "").trim()
  if (alt.length > 0) return alt

  if (opts.allowQueryToken && opts.url) {
    const queryToken =
      (opts.url.searchParams.get("token") ?? opts.url.searchParams.get("access_token"))?.trim() ??
      ""
    if (queryToken.length > 0) return queryToken
  }

  return null
}
