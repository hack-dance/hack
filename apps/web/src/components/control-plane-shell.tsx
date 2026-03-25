import { ArrowRight, Compass, Keyboard, ShieldCheck } from "lucide-react";
import AccountControlPlaneSections from "@/src/components/account-control-plane-sections";
import type { AccountControlPlaneFeedback } from "@/src/lib/account-control-plane";
import type { AccountShellContext } from "@/src/lib/account-shell";
import {
  shellGuardrails,
  shellHighlights,
  shellNavigationItems,
  shellPrinciples,
  shellSummary,
  shellTitle,
} from "@/src/lib/control-plane-shell";
import { cn } from "@/src/lib/utils";

const interactiveSurfaceClassName = cn(
  "rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(15,23,42,0.24)]",
  "transition duration-200 motion-safe:hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const focusLinkClassName = cn(
  "rounded-full px-4 py-2 text-sm text-white/80",
  "transition duration-200 hover:bg-white/8 hover:text-white motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

type ControlPlaneShellProps = {
  readonly account?: AccountShellContext;
  readonly feedback?: AccountControlPlaneFeedback | null;
  readonly returnToPath: string;
  readonly signInHref?: string;
};

type AuthenticatedAccount = Extract<
  AccountShellContext,
  { readonly authenticated: true }
>;

const fallbackAccountContext = {
  authenticated: false,
} as const satisfies AccountShellContext;

export default function ControlPlaneShell({
  account = fallbackAccountContext,
  feedback = null,
  returnToPath,
  signInHref = "/auth?redirect=%2F",
}: ControlPlaneShellProps) {
  const identityLabel = account.authenticated
    ? formatIdentityLabel({ account })
    : null;

  return (
    <div className="relative isolate min-h-screen overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.24),transparent_46%)]"
      />

      <a
        className={cn(
          "absolute top-4 left-4 z-50 -translate-y-24 rounded-full bg-sky-300 px-4 py-2 font-medium text-slate-950 text-sm",
          "transition-transform duration-200 focus:translate-y-0 focus-visible:translate-y-0 motion-reduce:transition-none",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
        )}
        href="#main-content"
      >
        Skip to main content
      </a>

      <header className="border-white/10 border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10 sm:px-10 lg:px-12">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl space-y-4">
              <span className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-300/10 px-3 py-1 text-sky-100 text-sm">
                <Compass aria-hidden="true" className="size-4" />
                {account.authenticated ? "Hack account" : "Hack control plane"}
              </span>
              <div className="space-y-3">
                <h1 className="font-semibold text-4xl text-white tracking-tight sm:text-5xl">
                  {shellTitle}
                </h1>
                <p className="max-w-3xl text-base text-white/75 leading-7 sm:text-lg">
                  {shellSummary}
                </p>
              </div>
            </div>

            <ul aria-label="Shell principles" className="flex flex-wrap gap-3">
              {shellPrinciples.map(({ title }) => (
                <li key={title}>
                  <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80">
                    {title}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.8fr)]">
            <section className={cn(interactiveSurfaceClassName, "p-6 sm:p-7")}>
              <div className="flex items-center gap-2 text-sky-100 text-sm">
                <Keyboard aria-hidden="true" className="size-4" />
                Keyboard-first orientation
              </div>
              <p className="mt-3 max-w-2xl text-sm text-white/75 leading-6">
                Use the skip link, tab through the shell navigation, and land in
                a semantic main region without crossing unfinished auth or admin
                flows.
              </p>
            </section>

            <section className={cn(interactiveSurfaceClassName, "p-6 sm:p-7")}>
              <div className="flex items-center gap-2 text-sky-100 text-sm">
                <ShieldCheck aria-hidden="true" className="size-4" />
                Neutral foundation
              </div>
              <p className="mt-3 text-sm text-white/75 leading-6">
                The routed shell is ready for later slices while staying
                explicit about what does not belong to this commit.
              </p>
            </section>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10 sm:px-10 lg:grid-cols-[18rem_minmax(0,1fr)] lg:px-12">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <nav
            aria-label="Control plane sections"
            className={cn(
              interactiveSurfaceClassName,
              "flex flex-col gap-2 p-3"
            )}
          >
            {shellNavigationItems.map(({ description, href, label }) => (
              <a className={focusLinkClassName} href={href} key={href}>
                <span className="flex items-center justify-between gap-3">
                  <span className="font-medium text-white">{label}</span>
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 text-white/45"
                  />
                </span>
                <span className="mt-1 block text-white/60 text-xs">
                  {description}
                </span>
              </a>
            ))}
          </nav>
        </aside>

        <main
          className="space-y-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-4"
          id="main-content"
          tabIndex={-1}
        >
          <section
            className={cn(interactiveSurfaceClassName, "p-6 sm:p-7")}
            id="account-context"
          >
            {account.authenticated ? (
              <div className="space-y-6">
                <div className="space-y-3">
                  <p className="font-medium text-sky-100 text-sm">
                    Signed in context
                  </p>
                  <div className="space-y-2">
                    <h2 className="font-semibold text-2xl text-white">
                      {identityLabel}
                    </h2>
                    <p className="max-w-3xl text-sm text-white/75 leading-7">
                      This account shell mirrors the broker current-user payload
                      and the same org/team context that{" "}
                      <code className="rounded bg-white/8 px-1.5 py-0.5 text-white text-xs">
                        hack auth status --json
                      </code>{" "}
                      resolves locally.
                    </p>
                  </div>
                </div>

                <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <ContextCard
                    label="Email"
                    value={account.user.email ?? "Not provided"}
                  />
                  <ContextCard
                    label="Organization"
                    value={formatNamedEntity({
                      entity: account.activeOrganization,
                      emptyLabel: "No active organization",
                    })}
                  />
                  <ContextCard
                    label="Team"
                    value={formatNamedEntity({
                      entity: account.activeTeam,
                      emptyLabel: "No active team",
                    })}
                  />
                  <ContextCard
                    label="Access mode"
                    value={account.accessControlMode ?? "Unknown"}
                  />
                </dl>

                <div className="flex flex-wrap gap-3">
                  <a className={focusLinkClassName} href={account.shellPath}>
                    Open browser sign-in
                  </a>
                  <a className={focusLinkClassName} href={account.accountPath}>
                    View handoff status
                  </a>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <h2 className="font-semibold text-2xl text-white">
                  Sign in to load your Hack account context
                </h2>
                <p className="max-w-3xl text-sm text-white/75 leading-7">
                  Open the browser-owned sign-in entrypoint and Hack will return
                  to this shell with the same identity, org, and team context
                  that the broker and CLI expose.
                </p>
                <a className={focusLinkClassName} href={signInHref}>
                  Continue to sign in
                </a>
              </div>
            )}
          </section>

          <AccountControlPlaneSections
            account={account}
            feedback={feedback}
            returnToPath={returnToPath}
          />

          <section className="space-y-4" id="foundations">
            <div className="space-y-2">
              <h2 className="font-semibold text-2xl text-white">Foundations</h2>
              <p className="max-w-3xl text-sm text-white/70 leading-7">
                The shell introduces reusable accessibility and layout patterns
                for later browser-owned slices.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {shellHighlights.map(({ description, title }) => (
                <article
                  className={cn(interactiveSurfaceClassName, "p-6")}
                  key={title}
                >
                  <h3 className="font-medium text-lg text-white">{title}</h3>
                  <p className="mt-3 text-sm text-white/70 leading-6">
                    {description}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section
            className={cn(interactiveSurfaceClassName, "p-6 sm:p-7")}
            id="guardrails"
          >
            <h2 className="font-semibold text-2xl text-white">Guardrails</h2>
            <ul className="mt-4 space-y-3 text-sm text-white/75 leading-6">
              {shellGuardrails.map((guardrail) => (
                <li className="flex gap-3" key={guardrail}>
                  <span
                    aria-hidden="true"
                    className="mt-2 size-2 rounded-full bg-sky-300"
                  />
                  <span>{guardrail}</span>
                </li>
              ))}
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}

function ContextCard(input: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className={cn(interactiveSurfaceClassName, "space-y-2 p-4")}>
      <dt className="font-medium text-sky-100 text-sm">{input.label}</dt>
      <dd className="text-sm text-white/80 leading-6">{input.value}</dd>
    </div>
  );
}

function formatIdentityLabel(input: {
  readonly account: AuthenticatedAccount;
}): string {
  return (
    input.account.user.name ?? input.account.user.email ?? input.account.user.id
  );
}

function formatNamedEntity(input: {
  readonly entity:
    | AuthenticatedAccount["activeOrganization"]
    | AuthenticatedAccount["activeTeam"];
  readonly emptyLabel: string;
}): string {
  if (!input.entity) {
    return input.emptyLabel;
  }

  return input.entity.name ?? input.entity.id;
}
