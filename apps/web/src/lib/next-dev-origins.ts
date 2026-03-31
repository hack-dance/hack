const URL_ENV_KEYS = [
  "NEXT_PUBLIC_HACK_WEB_APP_BASE_URL",
  "HACK_WEB_APP_BASE_URL",
  "NEXT_PUBLIC_APP_BASE_URL",
  "APP_BASE_URL",
] as const;

const HOST_ENV_KEYS = [
  "NEXT_PUBLIC_HACK_LOCAL_DEV_HOST",
  "HACK_LOCAL_DEV_HOST",
] as const;

const ORIGIN_LIST_ENV_KEYS = ["BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const HOSTNAME_PATTERN = /^(?:\*\.)?[a-z0-9.-]+$/;

/**
 * Resolve the additional hostnames that should be allowed to reach the Next.js
 * dev server when the app is routed behind `hack` hostnames instead of
 * `localhost`.
 */
export function resolveAllowedDevOrigins(input?: {
  readonly env?: Record<string, string | undefined>;
}): string[] {
  const env = input?.env ?? process.env;
  const allowedOrigins = new Set<string>();

  for (const key of URL_ENV_KEYS) {
    addUrlOrigin({
      allowedOrigins,
      value: env[key],
    });
  }

  for (const key of HOST_ENV_KEYS) {
    addHostOrigin({
      allowedOrigins,
      value: env[key],
    });
  }

  for (const key of ORIGIN_LIST_ENV_KEYS) {
    const value = env[key];
    if (!value) {
      continue;
    }
    for (const entry of value.split(",")) {
      addHostOrUrlOrigin({
        allowedOrigins,
        value: entry,
      });
    }
  }

  return [...allowedOrigins];
}

function addUrlOrigin(input: {
  readonly allowedOrigins: Set<string>;
  readonly value?: string;
}) {
  const normalizedOrigin = normalizeUrlOrigin({
    value: input.value,
  });
  if (!normalizedOrigin) {
    return;
  }
  input.allowedOrigins.add(normalizedOrigin);
}

function addHostOrigin(input: {
  readonly allowedOrigins: Set<string>;
  readonly value?: string;
}) {
  const normalizedOrigin = normalizeHostOrigin({
    value: input.value,
  });
  if (!normalizedOrigin) {
    return;
  }
  input.allowedOrigins.add(normalizedOrigin);
}

function addHostOrUrlOrigin(input: {
  readonly allowedOrigins: Set<string>;
  readonly value?: string;
}) {
  const normalizedOrigin = normalizeHostOrUrlOrigin({
    value: input.value,
  });
  if (!normalizedOrigin) {
    return;
  }
  input.allowedOrigins.add(normalizedOrigin);
}

function normalizeUrlOrigin(input: { readonly value?: string }): string | null {
  const value = input.value?.trim().toLowerCase();
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function normalizeHostOrUrlOrigin(input: {
  readonly value?: string;
}): string | null {
  return (
    normalizeUrlOrigin({
      value: input.value,
    }) ??
    normalizeHostOrigin({
      value: input.value,
    })
  );
}

function normalizeHostOrigin(input: {
  readonly value?: string;
}): string | null {
  const value = input.value?.trim().toLowerCase();
  if (!(value && HOSTNAME_PATTERN.test(value))) {
    return null;
  }
  if (value.startsWith("*.")) {
    const wildcardTarget = value.slice(2).trim();
    return wildcardTarget.length > 0 ? `*.${wildcardTarget}` : null;
  }
  return value.length > 0 ? value : null;
}
