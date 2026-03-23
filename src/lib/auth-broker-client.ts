import {
  type FetchLike,
  loadHackAuthSession,
  resolveHackAuthBrokerBaseUrl,
} from "./auth-session.ts";

type BrokerResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly brokerBaseUrl: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly brokerBaseUrl: string;
      readonly loginRequired: boolean;
    };

export async function requestHackAuthBroker(input: {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly query?: Record<string, string | undefined>;
  readonly body?: Record<string, unknown>;
  readonly brokerUrl?: string;
  readonly fetchImpl?: FetchLike;
}): Promise<BrokerResult<Record<string, unknown>>> {
  const brokerBaseUrl = resolveHackAuthBrokerBaseUrl({
    override: input.brokerUrl,
  });
  const stored = await loadHackAuthSession().catch(() => null);
  const token = stored?.token?.trim() ?? "";
  if (!token) {
    return {
      ok: false,
      error:
        "Hack auth login is required for broker-managed org and team commands. Run `hack auth login` and retry.",
      brokerBaseUrl,
      loginRequired: true,
    };
  }

  const url = new URL(input.path, `${brokerBaseUrl}/`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (typeof value === "string" && value.trim()) {
      url.searchParams.set(key, value.trim());
    }
  }

  const fetchImpl: FetchLike =
    input.fetchImpl ?? ((resource, init) => fetch(resource, init));

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error: `Unable to reach Hack auth broker route ${input.path}: ${toErrorMessage(error)}`,
      brokerBaseUrl,
      loginRequired: false,
    };
  }

  const body = await readJsonBody({ response });
  if (!response.ok) {
    const remoteError = readOptionalString(
      (body as Record<string, unknown>).error
    );
    return {
      ok: false,
      error: remoteError
        ? `Hack auth broker rejected ${input.path} (HTTP ${response.status}): ${remoteError}`
        : `Hack auth broker rejected ${input.path} (HTTP ${response.status}).`,
      brokerBaseUrl,
      loginRequired: response.status === 401,
    };
  }

  return {
    ok: true,
    value: isRecord(body) ? body : { ok: true },
    brokerBaseUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(input: {
  readonly response: Response;
}): Promise<unknown> {
  const text = await input.response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
