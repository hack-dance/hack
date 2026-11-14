import {
  invokeNativeRuntime,
  resolveNativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import {
  type CliContext,
  type CommandArgs,
  defineCommand,
  withHandler,
} from "../cli/command.ts";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { keys } from "../lib/native-compose-private-state.ts";

const options = [
  {
    name: "reconcile",
    type: "boolean",
    long: "--reconcile",
    description:
      "Retire only sessions with proven exit, container absence or a stopped boot",
  },
  {
    name: "json",
    type: "boolean",
    long: "--json",
    description: "Print value-free session evidence as JSON",
  },
] as const;
const spec = defineCommand({
  name: "exec-sessions",
  summary: "List retained native interactive exec sessions in this native home",
  group: "Diagnostics",
  options,
  positionals: [],
  subcommands: [],
} as const);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RUN = /^[a-f0-9]{32}$/;
const SERVICE = /^[a-zA-Z0-9_.-]{1,128}$/;

export function parseExecSessions(value: unknown) {
  if (
    !(
      isRecord(value) &&
      keys(value, "reconciled,sessions,version") &&
      value.version === 1 &&
      (value.reconciled === null || typeof value.reconciled === "boolean") &&
      Array.isArray(value.sessions) &&
      value.sessions.length <= 1024
    )
  ) {
    throw new ClosedCliError(
      "Native session evidence is unavailable; nothing was cleared."
    );
  }
  const sessions = value.sessions.map((r: unknown) => {
    if (
      !(
        isRecord(r) &&
        keys(r, "has_exec,run,service,session") &&
        typeof r.session === "string" &&
        UUID.test(r.session) &&
        typeof r.run === "string" &&
        RUN.test(r.run) &&
        typeof r.service === "string" &&
        SERVICE.test(r.service) &&
        typeof r.has_exec === "boolean"
      )
    ) {
      throw new ClosedCliError(
        "Native session evidence is invalid; values omitted."
      );
    }
    return {
      session: r.session,
      run: r.run,
      service: r.service,
      has_exec: r.has_exec,
    };
  });
  if (new Set(sessions.map((r) => r.session)).size !== sessions.length) {
    throw new ClosedCliError(
      "Native session evidence contains duplicate identities."
    );
  }
  return { version: 1, sessions, reconciled: value.reconciled };
}

async function handle({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof options, readonly []>;
}): Promise<number> {
  const runtime = resolveNativeRuntimeSelection();
  if (!runtime) {
    throw new ClosedCliError(
      "exec-sessions requires the native candidate CLI and its selected native home."
    );
  }
  const result = parseExecSessions(
    await invokeNativeRuntime({
      runtime,
      cwd: ctx.cwd,
      args: [
        "graph",
        "interactive-sessions",
        ...(args.options.reconcile ? ["--reconcile"] : []),
        "--json",
      ],
      timeoutMs: 15_000,
    })
  );
  if (args.options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `${result.sessions.length} retained interactive session(s) in this native home.`
    );
    for (const r of result.sessions) {
      console.log(
        `${r.service} run=${r.run} session=${r.session} ${r.has_exec ? "exec recorded" : "intent only"}`
      );
    }
    if (result.sessions.length > 0) {
      console.log(
        "Run hack exec-sessions --reconcile to clear proven exits; otherwise use hack down for the affected project."
      );
    }
    if (result.reconciled === false) {
      console.log(
        "Reconciliation was incomplete; the listing above reflects the evidence that remains."
      );
    }
  }
  return result.reconciled === false ? 1 : 0;
}
export const execSessionsCommand = withHandler(spec, handle);
