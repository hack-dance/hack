import { childEnvironment } from "./child-environment.ts";

/** Only platform and Docker transport settings are inputs to inspect/logs/events. */
const DOCKER_HELPER_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "DOCKER_CUSTOM_HEADERS",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "PODMAN_CONNECTIONS_CONF",
  "CONTAINERS_CONF",
  "CONTAINERS_CONF_OVERRIDE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** Exclude application values, including managed globals and Compose reference values. */
export function dockerHelperEnvironment(
  overrides?: Readonly<Record<string, string>>
): Record<string, string> {
  const env = childEnvironment(process.env, overrides);
  for (const key of Object.keys(env)) {
    if (!DOCKER_HELPER_NAMES.has(key)) {
      delete env[key];
    }
  }
  return env;
}

/** Shell runners otherwise merge the caller environment back into the allow-list. */
export function dockerHelperRunEnvironment(
  overrides?: Readonly<Record<string, string>>
) {
  return {
    env: dockerHelperEnvironment(overrides),
    unsetEnvKeys: Object.keys(process.env),
  };
}
