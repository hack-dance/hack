import { Compass } from "lucide-react";

import { shellSummary, shellTitle } from "@/src/lib/control-plane-shell";
import { cn } from "@/src/lib/utils";

const loadingSurfaceClassName = cn(
  "rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(15,23,42,0.24)]",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const loadingPlaceholderClassName =
  "rounded-full bg-white/10 animate-pulse motion-reduce:animate-none";

export default function AccountShellLoading() {
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
                Hack account
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

            <div aria-hidden="true" className="flex flex-wrap gap-3">
              <div className={cn(loadingPlaceholderClassName, "h-10 w-28")} />
              <div className={cn(loadingPlaceholderClassName, "h-10 w-36")} />
              <div className={cn(loadingPlaceholderClassName, "h-10 w-32")} />
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10 sm:px-10 lg:grid-cols-[18rem_minmax(0,1fr)] lg:px-12">
        <aside aria-hidden="true" className="lg:sticky lg:top-8 lg:self-start">
          <div className={cn(loadingSurfaceClassName, "space-y-3 p-6")}>
            <div className={cn(loadingPlaceholderClassName, "h-4 w-32")} />
            <div className={cn(loadingPlaceholderClassName, "h-4 w-28")} />
            <div className={cn(loadingPlaceholderClassName, "h-4 w-36")} />
            <div className={cn(loadingPlaceholderClassName, "h-4 w-24")} />
          </div>
        </aside>

        <main
          className="space-y-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-4"
          id="main-content"
          tabIndex={-1}
        >
          <section
            className={cn(loadingSurfaceClassName, "space-y-4 p-6 sm:p-7")}
          >
            <p className="font-medium text-sky-100 text-sm">
              Loading account context
            </p>
            <div className="space-y-3">
              <h2 className="font-semibold text-2xl text-white">
                Resolving your Hack account shell…
              </h2>
              <p className="max-w-3xl text-sm text-white/75 leading-7">
                Hack is reconciling the browser sign-in handoff, repo env
                status, and integration state before rendering the full account
                shell.
              </p>
            </div>
            <div
              aria-hidden="true"
              className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
            >
              <div className={cn(loadingPlaceholderClassName, "h-24")} />
              <div className={cn(loadingPlaceholderClassName, "h-24")} />
              <div className={cn(loadingPlaceholderClassName, "h-24")} />
              <div className={cn(loadingPlaceholderClassName, "h-24")} />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
