import type { AccountControlPlaneFeedback } from "@/lib/account-control-plane";
import type { LinearManagementState } from "@/lib/linear-management";
import { cn } from "@/lib/utils";

const sectionSurfaceClassName = cn(
  "rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(15,23,42,0.24)]",
  "transition duration-200 motion-safe:hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const codeClassName =
  "rounded-2xl bg-slate-950/70 px-4 py-3 text-sm text-white/85";

export default function LinearManagementSection(input: {
  readonly linearManagement: LinearManagementState;
  readonly scopeFeedback?: AccountControlPlaneFeedback | null;
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

      {input.scopeFeedback ? (
        <section
          className={cn(
            sectionSurfaceClassName,
            "p-5",
            input.scopeFeedback.tone === "success" &&
              "border-emerald-300/30 bg-emerald-500/10",
            input.scopeFeedback.tone === "danger" &&
              "border-rose-300/30 bg-rose-500/10",
            input.scopeFeedback.tone === "info" &&
              "border-sky-300/30 bg-sky-500/10"
          )}
          role={input.scopeFeedback.tone === "danger" ? "alert" : "status"}
        >
          <p className="font-medium text-sky-100 text-sm">
            {input.scopeFeedback.title}
          </p>
          <p className="mt-3 text-sm text-white/80 leading-6">
            {input.scopeFeedback.body}
          </p>
        </section>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <LinearOverviewSection
          hackConnectionLabel={hackConnectionLabel}
          linearManagement={linearManagement}
          localAccessLabel={localAccessLabel}
        />
        <LinearBindingSection linearManagement={linearManagement} />
      </div>
    </section>
  );
}

function LinearOverviewSection(input: {
  readonly linearManagement: LinearManagementState;
  readonly localAccessLabel: string;
  readonly hackConnectionLabel: string;
}) {
  const readinessLabel =
    input.linearManagement.hackConnection.connected &&
    input.linearManagement.localAccess.ready
      ? "Ready"
      : "Needs attention";
  const localStatusLabel = input.linearManagement.summary.connected
    ? "local ready"
    : "local repair";

  return (
    <section className={cn(sectionSurfaceClassName, "space-y-6 p-6 sm:p-7")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="font-medium text-sky-100 text-sm">{readinessLabel}</p>
          <h3 className="font-medium text-white text-xl">
            {input.linearManagement.hackConnection.summary}
          </h3>
          <p className="max-w-3xl text-sm text-white/70 leading-6">
            {input.linearManagement.hackConnection.detail}
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
          {localStatusLabel}
        </span>
      </div>

      <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DetailCard label="Active profile">
          {input.linearManagement.selectedProfile}
        </DetailCard>
        <DetailCard label="Routing source">
          {input.linearManagement.selectedSource}
        </DetailCard>
        <DetailCard label="Connected on Hack">
          {input.hackConnectionLabel}
        </DetailCard>
        <DetailCard label="Local access">{input.localAccessLabel}</DetailCard>
        <DetailCard label="Hack owner">
          {input.linearManagement.hackConnection.ownerLabel ?? "No Hack owner"}
        </DetailCard>
        <DetailCard label="Connected account">
          {input.linearManagement.hackConnection.accountLabel}
        </DetailCard>
      </dl>

      <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <p className="font-medium text-sm text-white">
          Repo-bound status commands
        </p>
        <code className={codeClassName}>
          {input.linearManagement.statusCommand}
        </code>
        <code className={codeClassName}>
          {input.linearManagement.connectionsCommand}
        </code>
        <p className="text-sm text-white/65 leading-6">
          Compare the browser view with the same repo-bound status and
          connection payloads the CLI exposes for this machine.
        </p>
      </div>

      {input.linearManagement.summary.capabilities.length > 0 ? (
        <section className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
          <p className="font-medium text-sm text-white">Available now</p>
          <ul className="grid gap-3 text-sm text-white/75 leading-6">
            {input.linearManagement.summary.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {input.linearManagement.repair ? (
        <section className="grid gap-3 rounded-2xl border border-amber-300/20 bg-amber-500/10 p-4">
          <p className="font-medium text-amber-100 text-sm">
            {input.linearManagement.repair.title}
          </p>
          <p className="text-sm text-white/75 leading-6">
            {input.linearManagement.repair.reason}
          </p>
          <code className={codeClassName}>
            {input.linearManagement.repair.command}
          </code>
        </section>
      ) : null}
    </section>
  );
}

function LinearBindingSection(input: {
  readonly linearManagement: LinearManagementState;
}) {
  return (
    <section className={cn(sectionSurfaceClassName, "space-y-6 p-6 sm:p-7")}>
      <div className="space-y-2">
        <h3 className="font-medium text-white text-xl">Binding visibility</h3>
        <p className="text-sm text-white/70 leading-6">
          The default route and additional linked projects stay visible without
          duplication so the current repo routing context remains explicit.
        </p>
      </div>

      <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DetailCard label="Repo route profile">
          {input.linearManagement.projectBinding.profileId ??
            "No repo profile override"}
        </DetailCard>
        <DetailCard label="Default route">
          {input.linearManagement.projectBinding.defaultProject?.label ??
            "No default Linear route"}
        </DetailCard>
        <DetailCard label="Additional linked projects">
          {String(
            input.linearManagement.projectBinding.additionalProjects.length
          )}
        </DetailCard>
      </dl>

      {input.linearManagement.projectBinding.additionalProjects.length > 0 ? (
        <ul className="grid gap-3">
          {input.linearManagement.projectBinding.additionalProjects.map(
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
          No additional linked projects are in scope for this repo right now.
        </p>
      )}

      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="space-y-2">
          <p className="font-medium text-sm text-white">Available profiles</p>
          <p className="text-sm text-white/70 leading-6">
            Keep the default profile, project override, and saved profile
            metadata visible so repairs target the right route quickly.
          </p>
        </div>

        <dl className="grid gap-3 md:grid-cols-3">
          <DetailCard label="Default profile">
            {input.linearManagement.defaultProfile}
          </DetailCard>
          <DetailCard label="Project override">
            {input.linearManagement.projectOverride ?? "No project override"}
          </DetailCard>
          <DetailCard label="Extension enabled">
            {input.linearManagement.extensionEnabled ? "yes" : "no"}
          </DetailCard>
        </dl>

        <LinearProfilesList linearManagement={input.linearManagement} />
      </div>

      <RepoAuditSection audit={input.linearManagement.audit} />
    </section>
  );
}

function LinearProfilesList(input: {
  readonly linearManagement: LinearManagementState;
}) {
  if (input.linearManagement.profiles.length === 0) {
    return (
      <p className="text-sm text-white/70 leading-6">
        No Linear profiles are configured for this repo yet.
      </p>
    );
  }

  return (
    <ul className="grid gap-3">
      {input.linearManagement.profiles.map((profile) => {
        const selected = profile.id === input.linearManagement.selectedProfile;
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
              <DetailCard label="Auth ref">{profile.authRef}</DetailCard>
              <DetailCard label="Token env">{profile.tokenEnv}</DetailCard>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function RepoAuditSection(input: {
  readonly audit: LinearManagementState["audit"];
}) {
  const latestPublished = input.audit?.statusUpdates.latestPublished ?? null;
  const deliveryAudit = input.audit?.delivery ?? null;
  const deliveryCorruption = input.audit?.deliveryCorruption ?? null;
  const closeout = input.audit?.closeout ?? null;
  const draftCount = input.audit?.statusUpdates.draftCount ?? 0;
  const draftLabel = `${draftCount} draft${draftCount === 1 ? "" : "s"} still waiting to publish`;

  return (
    <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="space-y-2">
        <h4 className="font-medium text-lg text-white">Repo audit trail</h4>
        <p className="text-sm text-white/70 leading-6">
          Keep publish metadata and the latest delivery reconciliation visible
          from the same repo-bound state the CLI reports.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <PublishedStatusUpdateAuditCard
          draftLabel={draftLabel}
          latestPublished={latestPublished}
        />
        <DeliveryAuditCard
          deliveryAudit={deliveryAudit}
          deliveryCorruption={deliveryCorruption}
        />
        <CloseoutAuditCard closeout={closeout} />
      </div>
    </section>
  );
}

function PublishedStatusUpdateAuditCard(input: {
  readonly draftLabel: string;
  readonly latestPublished:
    | NonNullable<
        LinearManagementState["audit"]
      >["statusUpdates"]["latestPublished"]
    | null;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
      <p className="font-medium text-sm text-white">
        Latest published status update
      </p>
      {input.latestPublished ? (
        <>
          <p className="font-medium text-white">
            {input.latestPublished.title}
          </p>
          <dl className="grid gap-3 md:grid-cols-2">
            <DetailCard label="Remote identity">
              {input.latestPublished.linearId ?? "Pending remote identity"}
            </DetailCard>
            <DetailCard label="Published metadata">
              {input.latestPublished.publishedAt ??
                input.latestPublished.updatedAt ??
                input.latestPublished.path}
            </DetailCard>
          </dl>
          <p className="text-sm text-white/65 leading-6">
            {input.latestPublished.path}
          </p>
        </>
      ) : (
        <p className="text-sm text-white/70 leading-6">
          No published repo-bound status updates are recorded yet.
        </p>
      )}
      <p className="text-sm text-white/70 leading-6">{input.draftLabel}</p>
    </section>
  );
}

function DeliveryAuditCard(input: {
  readonly deliveryAudit: NonNullable<
    LinearManagementState["audit"]
  >["delivery"];
  readonly deliveryCorruption: NonNullable<
    LinearManagementState["audit"]
  >["deliveryCorruption"];
}) {
  if (input.deliveryCorruption) {
    return (
      <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
        <p className="font-medium text-sm text-white">
          Latest delivery reconciliation
        </p>
        <p className="font-medium text-rose-100">Delivery audit is corrupt</p>
        <p className="text-sm text-white/70 leading-6">
          {input.deliveryCorruption.message}
        </p>
        <code className={codeClassName}>{input.deliveryCorruption.path}</code>
        <p className="text-amber-100 text-sm leading-6">
          {input.deliveryCorruption.recovery}
        </p>
      </section>
    );
  }

  if (!input.deliveryAudit) {
    return (
      <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
        <p className="font-medium text-sm text-white">
          Latest delivery reconciliation
        </p>
        <p className="text-sm text-white/70 leading-6">
          No durable delivery audit is recorded yet. Run the repo-bound autosync
          flow to capture processed, applied, and failed counts.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
      <p className="font-medium text-sm text-white">
        Latest delivery reconciliation
      </p>
      <dl className="grid gap-3 md:grid-cols-2">
        <DetailCard label="Processed">
          {`processed ${input.deliveryAudit.processedDeliveries}`}
        </DetailCard>
        <DetailCard label="Applied">
          {`applied ${input.deliveryAudit.appliedDeliveries}`}
        </DetailCard>
        <DetailCard label="Failed">
          {`failed ${input.deliveryAudit.failedDeliveries}`}
        </DetailCard>
        <DetailCard label="Updated">{input.deliveryAudit.updatedAt}</DetailCard>
      </dl>
      {input.deliveryAudit.deliveries.length > 0 ? (
        <ul className="grid gap-3">
          {input.deliveryAudit.deliveries.map((delivery) => (
            <li
              className="rounded-2xl border border-white/10 bg-white/5 p-3"
              key={delivery.deliveryId}
            >
              <p className="font-medium text-sm text-white">
                {delivery.deliveryId}
              </p>
              <p className="text-sm text-white/70 leading-6">
                {delivery.mode} · {delivery.status}
                {delivery.issueIdentifier
                  ? ` · ${delivery.issueIdentifier}`
                  : ""}
              </p>
              {delivery.reason ? (
                <p className="text-amber-100 text-sm leading-6">
                  {delivery.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <code className={codeClassName}>{input.deliveryAudit.path}</code>
    </section>
  );
}

function CloseoutAuditCard(input: {
  readonly closeout: NonNullable<LinearManagementState["audit"]>["closeout"];
}) {
  if (!input.closeout) {
    return (
      <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
        <p className="font-medium text-sm text-white">Mission closeout</p>
        <p className="text-sm text-white/70 leading-6">
          No repo-bound closeout scope is recorded yet for this Linear project.
        </p>
      </section>
    );
  }

  const unresolvedEntries = input.closeout.entries.filter(
    (entry) => entry.status !== "done"
  );

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/35 p-4">
      <p className="font-medium text-sm text-white">Mission closeout</p>
      <p className="text-sm text-white/70 leading-6">
        Track the frozen mission scope against repo-bound synced ticket status
        so the browser and CLI report the same unresolved count.
      </p>
      <dl className="grid gap-3 md:grid-cols-2">
        <DetailCard label="Resolved">
          {`${input.closeout.resolvedCount}/${input.closeout.totalItems}`}
        </DetailCard>
        <DetailCard label="Unresolved">
          {String(input.closeout.unresolvedCount)}
        </DetailCard>
      </dl>
      {unresolvedEntries.length > 0 ? (
        <ul className="grid gap-3">
          {unresolvedEntries.map((entry) => (
            <li
              className="rounded-2xl border border-amber-300/20 bg-amber-500/10 p-3"
              key={entry.ticketId}
            >
              <p className="font-medium text-sm text-white">
                {entry.externalKey ?? entry.ticketId}
              </p>
              <p className="text-sm text-white/70 leading-6">{entry.title}</p>
              <p className="text-amber-100 text-sm leading-6">
                Current status: {entry.status}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-emerald-100 text-sm leading-6">
          All frozen mission-scoped Linear tickets now resolve to done from the
          repo-bound synced ticket store.
        </p>
      )}
      <code className={codeClassName}>{input.closeout.path}</code>
      <p className="text-sm text-white/65 leading-6">
        Published closeout evidence:{" "}
        {input.closeout.latestPublishedTitle ?? "Unavailable"}
      </p>
      {input.closeout.latestPublishedPath ? (
        <code className={codeClassName}>
          {input.closeout.latestPublishedPath}
        </code>
      ) : null}
      <p className="text-sm text-white/65 leading-6">
        Delivery audit state: {input.closeout.deliveryAuditState}
      </p>
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
