import { connect } from "node:net";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

/**
 * Native loopback TCP publication of Compose `ports`.
 *
 * The native runtime is the authority: it admits `ports` only for the
 * foreground owner, only as TCP on 127.0.0.1 with an explicit host port, and
 * checks every host port again under its provider lease before it binds. This
 * module only sizes the bridge pool and refuses an occupied host port before
 * graph admission, so a collision does not cost a full startup.
 */

/** Most bridge sockets one pool request may ask for (routes plus ports). */
const MAX_BRIDGE_SOCKETS = 32;

function unsupported(): Error {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native port publication supports at most 32 routes and published ports together; keep larger projects on the Compose backend.",
  });
}

/**
 * Count declared `ports` entries in every service, including inactive
 * profiles. A conservative upper bound used only to size bridge capacity
 * before review; unused capacity is harmless.
 */
export function nativePortPublicationCount(
  specs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): number {
  let count = 0;
  for (const spec of Object.values(specs)) {
    if (Array.isArray(spec.ports)) {
      count += spec.ports.length;
    }
  }
  return count;
}

/** Bridge sockets for routes plus published ports, bounded by the pool limit. */
export function nativeBridgeSocketCount(opts: {
  readonly routes: number;
  readonly ports: number;
}): number {
  const total = opts.routes + opts.ports;
  if (total > MAX_BRIDGE_SOCKETS) {
    throw unsupported();
  }
  return total;
}

/**
 * Host ports the reviewed plan publishes for active services. Only explicit
 * IPv4 loopback TCP publications are returned; the runtime refuses any other
 * active `ports` entry at admission.
 */
export function reviewedNativeLoopbackPorts(plan: unknown): number[] {
  if (!(isRecord(plan) && isRecord(plan.services))) {
    return [];
  }
  const ports = new Set<number>();
  for (const service of Object.values(plan.services)) {
    if (
      !(
        isRecord(service) &&
        service.active === true &&
        Array.isArray(service.ports)
      )
    ) {
      continue;
    }
    for (const port of service.ports) {
      if (
        isRecord(port) &&
        port.protocol === "tcp" &&
        port.proposed_host_ip === "127.0.0.1" &&
        Number.isInteger(port.published) &&
        Number(port.published) > 0 &&
        Number(port.published) <= 65_535
      ) {
        ports.add(Number(port.published));
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Resolve true when something accepts a TCP connection on 127.0.0.1:port. */
export function loopbackPortAccepts(
  port: number,
  timeoutMs = 250
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (accepting: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(accepting);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // Only a refused connection proves no loopback listener. Anything else
      // is not evidence that the port is free.
      finish(error.code !== "ECONNREFUSED");
    });
  });
}

/**
 * Refuse before graph admission when a published host port already accepts
 * loopback connections. The existing listener is left untouched. This is a
 * point-in-time check; the runtime repeats it under its lease and its own
 * exclusive bind is final.
 */
export async function checkNativeLoopbackPorts(
  ports: readonly number[],
  accepts: (port: number) => Promise<boolean> = loopbackPortAccepts
): Promise<void> {
  for (const port of ports) {
    if (await accepts(port)) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message: `Published host port ${port} is already in use on 127.0.0.1; the existing listener was left untouched. Stop it or change the published port.`,
      });
    }
  }
}
