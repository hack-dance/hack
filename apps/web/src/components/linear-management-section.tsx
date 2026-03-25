import type { LinearManagementState } from "@/src/lib/linear-management";
import { cn } from "@/src/lib/utils";

const sectionSurfaceClassName = cn(
  "rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(15,23,42,0.24)]",
  "transition duration-200 motion-safe:hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const codeClassName =
  "rounded-2xl bg-slate-950/70 px-4 py-3 text-sm text-white/85";

export default function LinearManagementSection(input: {
  readonly linearManagement: LinearManagementState;
}) {
  const { linearManagement } = input;
  const localAccessLabel = linearManagement.localAccess.ready
    ? `ready${linearManagement.tokenSource ? ` (${linearManagement.tokenSource})` : ""}`
    : "needs repair";
  let hackConnectionLabel = "sign in to inspect";
  if (linearManagement.hackConnection.inspectable) {
    hackConnectionLabel = linearManagement.hackConnection.connected
      ? "connected"
      : "not connected";
  }

  return (
    <section className="space-y-4" id="linear">
      <div className="space-y-2">
        <h2 className="font-semibold text-2xl text-white">Linear</h2>
        <p className="max-w-3xl text-sm text-white/70 leading-7">
          Compare Hack-owned connection state with locally usable Linear access,
          inspect the repo-bound default and linked projects, and repair the
          active failure mode without hiding the current routing context.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section
          className={cn(sectionSurfaceClassName, "space-y-6 p-6 sm:p-7")}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="font-medium text-sky-100 text-sm">
                {linearManagement.hackConnection.connected &&
                linearManagement.localAccess.ready
                  ? "Ready"
                  : "Needs attention"}
              </p>
              <h3 className="font-medium text-white text-xl">
                {linearManagement.hackConnection.summary}
              </h3>
              <p className="max-w-3xl text-sm text-white/70 leading-6">
                {linearManagement.hackConnection.detail}
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
              {linearManagement.summary.connected
                ? "local ready"
                : "local repair"}
            </span>
          </div>

          <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <DetailCard label="Active profile">
              {linearManagement.selectedProfile}
            </DetailCard>
            <DetailCard label="Routing source">
              {linearManagement.selectedSource}
            </DetailCard>
            <DetailCard label="Connected on Hack">
              {hackConnectionLabel}
            </DetailCard>
            <DetailCard label="Local access">{localAccessLabel}</DetailCard>
            <DetailCard label="Hack owner">
              {linearManagement.hackConnection.ownerLabel ?? "No Hack owner"}
            </DetailCard>
            <DetailCard label="Connected account">
              {linearManagement.hackConnection.accountLabel}
            </DetailCard>
          </dl>

          <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="font-medium text-sm text-white">
              Repo-bound status commands
            </p>
            <code className={codeClassName}>
              {linearManagement.statusCommand}
            </code>
            <code className={codeClassName}>
              {linearManagement.connectionsCommand}
            </code>
            <p className="text-sm text-white/65 leading-6">
              Compare the browser view with the same repo-bound status and
              connection payloads the CLI exposes for this machine.
            </p>
          </div>

          {linearManagement.summary.capabilities.length > 0 ? (
            <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="font-medium text-sm text-white">Available now</p>
              <ul className="grid gap-3 text-sm text-white/75 leading-6">
                {linearManagement.summary.capabilities.map((capability) => (
                  <li key={capability}>{capability}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {linearManagement.repair ? (
            <section className="grid gap-3 rounded-2xl border border-amber-300/20 bg-amber-500/10 p-4">
              <p className="font-medium text-amber-100 text-sm">
                {linearManagement.repair.title}
              </p>
              <p className="text-sm text-white/75 leading-6">
                {linearManagement.repair.reason}
              </p>
              <code className={codeClassName}>
                {linearManagement.repair.command}
              </code>
            </section>
          ) : null}
        </section>

        <section
          className={cn(sectionSurfaceClassName, "space-y-6 p-6 sm:p-7")}
        >
          <div className="space-y-2">
            <h3 className="font-medium text-white text-xl">
              Binding visibility
            </h3>
            <p className="text-sm text-white/70 leading-6">
              The default route and additional linked projects stay visible
              without duplication so the current repo routing context remains
              explicit.
            </p>
          </div>

          <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <DetailCard label="Repo route profile">
              {linearManagement.projectBinding.profileId ??
                "No repo profile override"}
            </DetailCard>
            <DetailCard label="Default route">
              {linearManagement.projectBinding.defaultProject?.label ??
                "No default Linear route"}
            </DetailCard>
            <DetailCard label="Additional linked projects">
              {String(
                linearManagement.projectBinding.additionalProjects.length
              )}
            </DetailCard>
          </dl>

          {linearManagement.projectBinding.additionalProjects.length > 0 ? (
            <ul className="grid gap-3">
              {linearManagement.projectBinding.additionalProjects.map(
                (project) => (
                  <li
                    className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                    key={project.projectId}
                  >
                    <p className="font-medium text-white">{project.label}</p>
                  </li>
                )
              )}
            </ul>
          ) : (
            <p className="text-sm text-white/70 leading-6">
              No additional linked projects are in scope for this repo right
              now.
            </p>
          )}

          <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="space-y-2">
              <p className="font-medium text-sm text-white">
                Available profiles
              </p>
              <p className="text-sm text-white/70 leading-6">
                Keep the default profile, project override, and saved profile
                metadata visible so repairs target the right route quickly.
              </p>
            </div>

            <dl className="grid gap-3 md:grid-cols-3">
              <DetailCard label="Default profile">
                {linearManagement.defaultProfile}
              </DetailCard>
              <DetailCard label="Project override">
                {linearManagement.projectOverride ?? "No project override"}
              </DetailCard>
              <DetailCard label="Extension enabled">
                {linearManagement.extensionEnabled ? "yes" : "no"}
              </DetailCard>
            </dl>

            {linearManagement.profiles.length > 0 ? (
              <ul className="grid gap-3">
                {linearManagement.profiles.map((profile) => {
                  const selected =
                    profile.id === linearManagement.selectedProfile;
                  let profileStateLabel = "saved";
                  if (selected) {
                    profileStateLabel = "active";
                  } else if (profile.isDefault) {
                    profileStateLabel = "default";
                  }
                  return (
                    <li
                      className={cn(
                        "rounded-2xl border p-4",
                        selected
                          ? "border-sky-300/35 bg-sky-300/10"
                          : "border-white/10 bg-slate-950/35"
                      )}
                      key={profile.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-2">
                          <p className="font-medium text-white">{profile.id}</p>
                          <p className="text-sm text-white/70 leading-6">
                            {profile.accountName ??
                              profile.accountEmail ??
                              profile.accountId ??
                              "No account snapshot"}
                          </p>
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
                          {profileStateLabel}
                        </span>
                      </div>
                      <dl className="mt-4 grid gap-3 md:grid-cols-2">
                        <DetailCard label="Auth ref">
                          {profile.authRef}
                        </DetailCard>
                        <DetailCard label="Token env">
                          {profile.tokenEnv}
                        </DetailCard>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-white/70 leading-6">
                No Linear profiles are configured for this repo yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function DetailCard(input: {
  readonly label: string;
  readonly children: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <dt className="font-medium text-sky-100 text-sm">{input.label}</dt>
      <dd className="mt-2 text-sm text-white/80 leading-6">{input.children}</dd>
    </div>
  );
}
