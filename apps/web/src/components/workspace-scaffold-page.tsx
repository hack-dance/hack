import {
  scaffoldMilestones,
  scaffoldSummary,
  scaffoldTitle,
} from "@/src/lib/workspace-scaffold";

export default function WorkspaceScaffoldPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-10 px-6 py-16 sm:px-10">
      <header className="flex flex-col gap-4">
        <span className="w-fit rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm text-white/70">
          Hack control plane
        </span>
        <div className="flex flex-col gap-3">
          <h1 className="font-semibold text-4xl text-white tracking-tight sm:text-5xl">
            {scaffoldTitle}
          </h1>
          <p className="max-w-3xl text-base text-white/75 leading-7 sm:text-lg">
            {scaffoldSummary}
          </p>
        </div>
      </header>

      <section
        aria-label="Upcoming control plane milestones"
        className="grid gap-4 md:grid-cols-3"
      >
        {scaffoldMilestones.map(({ description, title }) => (
          <article
            className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
            key={title}
          >
            <h2 className="font-medium text-lg text-white">{title}</h2>
            <p className="mt-3 text-sm text-white/70 leading-6">
              {description}
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
