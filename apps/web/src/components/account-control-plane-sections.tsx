import type { ReactNode } from "react";
import LinearManagementSection from "@/components/linear-management-section";
import type { AccountControlPlaneFeedback } from "@/lib/account-control-plane";
import { buildAccountControlPlanePath } from "@/lib/account-control-plane";
import type { AccountShellContext } from "@/lib/account-shell";
import type { EnvManagementState } from "@/lib/env-management";
import type { GitHubManagementState } from "@/lib/github-management";
import type { LinearManagementState } from "@/lib/linear-management";
import { cn } from "@/lib/utils";

const sectionSurfaceClassName = cn(
  "rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_24px_80px_rgba(15,23,42,0.24)]",
  "transition duration-200 motion-safe:hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const actionClassName = cn(
  "inline-flex min-h-10 items-center justify-center rounded-full border border-sky-300/30 bg-sky-300 px-4 py-2 font-medium text-slate-950 text-sm",
  "transition duration-200 hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const secondaryActionClassName = cn(
  "inline-flex min-h-10 items-center justify-center rounded-full border border-white/15 bg-white/5 px-4 py-2 font-medium text-sm text-white/85",
  "transition duration-200 hover:bg-white/10 motion-reduce:transition-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

const fieldClassName = cn(
  "w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-white/35",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
);

type AccountControlPlaneSectionsProps = {
  readonly account: AccountShellContext;
  readonly envManagement: EnvManagementState;
  readonly githubManagement: GitHubManagementState;
  readonly linearManagement: LinearManagementState;
  readonly feedback?: AccountControlPlaneFeedback | null;
  readonly returnToPath: string;
};

export default function AccountControlPlaneSections({
  account,
  envManagement,
  githubManagement,
  linearManagement,
  feedback = null,
  returnToPath,
}: AccountControlPlaneSectionsProps) {
  const integrationScopeFeedback = resolveSharedIntegrationScopeFeedback({
    account,
  });
  const selectedOrganizationKey = account.authenticated
    ? (account.selectedOrganization?.slug ?? account.requestedOrganizationKey)
    : null;
  const selectedTeamKey = account.authenticated
    ? (account.selectedTeam?.slug ?? account.requestedTeamKey)
    : null;
  const selectedProjectKey = account.authenticated
    ? (account.selectedProject?.slug ?? account.requestedProjectKey)
    : null;
  const scopedReturnPath = buildAccountControlPlanePath({
    redirectTo: returnToPath,
    org: selectedOrganizationKey,
    team: selectedTeamKey,
    project: selectedProjectKey,
  });
  const baseReturnPath = buildAccountControlPlanePath({
    redirectTo: returnToPath,
  });

  return (
    <>
      {feedback ? (
        <section
          className={cn(
            sectionSurfaceClassName,
            "p-6 sm:p-7",
            feedback.tone === "success" &&
              "border-emerald-300/30 bg-emerald-500/10",
            feedback.tone === "danger" && "border-rose-300/30 bg-rose-500/10",
            feedback.tone === "info" && "border-sky-300/30 bg-sky-500/10"
          )}
          data-feedback-key={feedback.title.toLowerCase().replaceAll(" ", "_")}
          role={feedback.tone === "danger" ? "alert" : "status"}
        >
          <p className="font-medium text-sky-100 text-sm">{feedback.title}</p>
          <p className="mt-3 max-w-3xl text-sm text-white/80 leading-6">
            {feedback.body}
          </p>
        </section>
      ) : null}

      <section className="space-y-4" id="organizations">
        <div className="space-y-2">
          <h2 className="font-semibold text-2xl text-white">Organizations</h2>
          <p className="max-w-3xl text-sm text-white/70 leading-7">
            Create shared organizations, keep list and detail views scoped to
            the current caller, and manage org invites without changing the
            broker-backed lifecycle semantics.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <CreateOrganizationCard
            authenticated={account.authenticated}
            returnToPath={baseReturnPath}
          />
          <OrganizationsCard
            account={account}
            returnToPath={returnToPath}
            scopedReturnPath={scopedReturnPath}
          />
        </div>
      </section>

      <TeamsSection account={account} returnToPath={returnToPath} />

      <ProjectsSection account={account} returnToPath={returnToPath} />

      <EnvSection envManagement={envManagement} />

      <GitHubSection
        githubManagement={githubManagement}
        scopeFeedback={integrationScopeFeedback}
      />

      <LinearManagementSection
        linearManagement={linearManagement}
        scopeFeedback={integrationScopeFeedback}
      />

      <section className="space-y-4" id="invitations">
        <div className="space-y-2">
          <h2 className="font-semibold text-2xl text-white">Invitations</h2>
          <p className="max-w-3xl text-sm text-white/70 leading-7">
            Only the intended recipient sees accept and decline actions. Pending
            invites remain non-active until this account responds.
          </p>
        </div>

        <InvitationsCard
          account={account}
          returnToPath={buildAccountControlPlanePath({
            redirectTo: returnToPath,
          })}
        />
      </section>
    </>
  );
}

function EnvSection(input: { readonly envManagement: EnvManagementState }) {
  const envManagement = input.envManagement;
  const sharedStateLabel = formatEnvClassificationLabel({
    value: envManagement.status.sharedState,
  });
  const missingRequiredCount = envManagement.missingRequired.length;

  return (
    <section className="space-y-4" id="env">
      <div className="space-y-2">
        <h2 className="font-semibold text-2xl text-white">Env</h2>
        <p className="max-w-3xl text-sm text-white/70 leading-7">
          Local env status stays explicit about trust model, custody, and
          portability so plaintext-compatible or local-only values are not
          mistaken for broker-managed shared env state.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section
          className={cn(sectionSurfaceClassName, "space-y-6 p-6 sm:p-7")}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="font-medium text-sky-100 text-sm">Effective env</p>
              <h3 className="font-medium text-white text-xl">
                {envManagement.status.summary}
              </h3>
              <p className="max-w-3xl text-sm text-white/70 leading-6">
                {envManagement.status.detail}
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
              {sharedStateLabel}
            </span>
          </div>

          <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ProjectDetailCard label="Env selection">
              {envManagement.envSelectionLabel}
            </ProjectDetailCard>
            <ProjectDetailCard label="Trust model">
              {envManagement.status.trustModel}
            </ProjectDetailCard>
            <ProjectDetailCard label="Custody">
              {envManagement.status.custody}
            </ProjectDetailCard>
            <ProjectDetailCard label="Portability">
              {envManagement.status.portability}
            </ProjectDetailCard>
            <ProjectDetailCard label="Shared state">
              {envManagement.status.sharedState}
            </ProjectDetailCard>
            <ProjectDetailCard label="Missing required">
              {missingRequiredCount > 0
                ? `${missingRequiredCount} key${missingRequiredCount === 1 ? "" : "s"}`
                : "None"}
            </ProjectDetailCard>
          </dl>

          <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="font-medium text-sm text-white">
              Repo-bound status commands
            </p>
            <code className="rounded-2xl bg-slate-950/70 px-4 py-3 text-sm text-white/85">
              {envManagement.statusCommand}
            </code>
            <code className="rounded-2xl bg-slate-950/70 px-4 py-3 text-sm text-white/85">
              {envManagement.backendCommand}
            </code>
            <p className="text-sm text-white/65 leading-6">
              Compare these repo-bound CLI status payloads with the browser view
              before treating local env as portable or shared.
            </p>
          </div>

          {envManagement.missingRequired.length > 0 ? (
            <div className="rounded-2xl border border-amber-300/20 bg-amber-500/10 p-4">
              <p className="font-medium text-amber-100 text-sm">
                Missing required env
              </p>
              <p className="mt-2 text-sm text-white/75 leading-6">
                {envManagement.missingRequired.join(", ")}
              </p>
            </div>
          ) : null}
        </section>

        <section
          className={cn(sectionSurfaceClassName, "space-y-4 p-6 sm:p-7")}
        >
          <div className="space-y-2">
            <h3 className="font-medium text-white text-xl">Storage surfaces</h3>
            <p className="text-sm text-white/70 leading-6">
              Each storage surface keeps its own machine-readable custody and
              portability state so local compatibility never looks like shared
              broker custody.
            </p>
          </div>

          <dl className="grid gap-4">
            <ProjectDetailCard label="Backend strategy">
              {envManagement.backend.name}
            </ProjectDetailCard>
            <ProjectDetailCard label="Backend storage mode">
              {envManagement.backend.status.storageMode}
            </ProjectDetailCard>
            <ProjectDetailCard label="Backend shared state">
              {envManagement.backend.classification.sharedState}
            </ProjectDetailCard>
            <ProjectDetailCard label="Local plaintext">
              {envManagement.localPlaintext.path}
            </ProjectDetailCard>
            <ProjectDetailCard label="Local plaintext custody">
              {envManagement.localPlaintext.classification.custody}
            </ProjectDetailCard>
            <ProjectDetailCard label="Local secrets">
              {`${envManagement.localSecrets.backend} (${envManagement.localSecrets.mode})`}
            </ProjectDetailCard>
            <ProjectDetailCard label="Local secret custody">
              {envManagement.localSecrets.classification.custody}
            </ProjectDetailCard>
            <ProjectDetailCard label="Portable state">
              {envManagement.portableState.status}
            </ProjectDetailCard>
            <ProjectDetailCard label="Portable shared state">
              {envManagement.portableState.classification.sharedState}
            </ProjectDetailCard>
          </dl>

          <div className="rounded-2xl border border-white/10 bg-slate-950/35 p-4">
            <p className="font-medium text-white">Compatibility output</p>
            <p className="mt-2 text-sm text-white/75 leading-6">
              {envManagement.compatibilityMode.summary}
            </p>
            <dl className="mt-4 grid gap-3 md:grid-cols-2">
              <ProjectDetailCard label="Plaintext target">
                {envManagement.compatibilityMode.plaintextTarget}
              </ProjectDetailCard>
              <ProjectDetailCard label="Secret backend">
                {envManagement.compatibilityMode.secretBackend}
              </ProjectDetailCard>
            </dl>
          </div>
        </section>
      </div>

      <section className={cn(sectionSurfaceClassName, "space-y-4 p-6 sm:p-7")}>
        <div className="space-y-2">
          <h3 className="font-medium text-white text-xl">Key-level status</h3>
          <p className="text-sm text-white/70 leading-6">
            Each repo-bound env key keeps its declared source, resolved source,
            storage kind/backend, and classification so the browser can
            distinguish local plaintext, secret-backed, and portable/shared
            values without exposing raw secrets.
          </p>
        </div>

        {envManagement.variables.length > 0 ? (
          <ul className="grid gap-3">
            {envManagement.variables.map((variable) => (
              <li
                className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                key={variable.key}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <p className="font-medium text-white">{variable.key}</p>
                    <p className="text-sm text-white/70 leading-6">
                      {formatEnvVariableStorageLabel({
                        variable,
                      })}
                    </p>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
                    {variable.required ? "required" : "optional"}
                  </span>
                </div>

                <dl className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <ProjectDetailCard label="Declared source">
                    {variable.source}
                  </ProjectDetailCard>
                  <ProjectDetailCard label="Resolved from">
                    {variable.resolvedSource ?? "unresolved"}
                  </ProjectDetailCard>
                  <ProjectDetailCard label="Storage">
                    {formatEnvVariableStorageLabel({
                      variable,
                    })}
                  </ProjectDetailCard>
                  <ProjectDetailCard label="Trust model">
                    {variable.storage.trustModel}
                  </ProjectDetailCard>
                  <ProjectDetailCard label="Custody">
                    {variable.storage.classification.custody}
                  </ProjectDetailCard>
                  <ProjectDetailCard label="Shared state">
                    {variable.storage.classification.sharedState}
                  </ProjectDetailCard>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/70 leading-6">
            {envManagement.status.sharedState === "unavailable"
              ? "Repo-bound env key status is unavailable until Hack can run the env status commands again."
              : "No repo-bound env keys were returned for this project."}
          </p>
        )}
      </section>
    </section>
  );
}

function GitHubSection(input: {
  readonly githubManagement: GitHubManagementState;
  readonly scopeFeedback: AccountControlPlaneFeedback | null;
}) {
  const githubManagement = input.githubManagement;
  const selectedProfile = githubManagement.selectedProfile;
  const selectedAccount =
    githubManagement.accountName ??
    githubManagement.accountLogin ??
    "Not resolved";
  const installationSummary = describeGitHubInstallation({
    githubManagement,
  });

  return (
    <section className="space-y-4" id="github">
      <div className="space-y-2">
        <h2 className="font-semibold text-2xl text-white">GitHub</h2>
        <p className="max-w-3xl text-sm text-white/70 leading-7">
          Repo-bound GitHub status stays honest about routing, profile
          selection, installation context, and repair steps instead of marking
          partial configuration as healthy.
        </p>
      </div>

      {input.scopeFeedback ? (
        <IntegrationScopeCard feedback={input.scopeFeedback} />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section
          className={cn(sectionSurfaceClassName, "space-y-6 p-6 sm:p-7")}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="font-medium text-sky-100 text-sm">
                {githubManagement.readiness.ready ? "Ready" : "Needs repair"}
              </p>
              <h3 className="font-medium text-white text-xl">
                {githubManagement.readiness.summary}
              </h3>
              <p className="max-w-3xl text-sm text-white/70 leading-6">
                {githubManagement.readiness.detail}
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
              {githubManagement.readiness.state.replaceAll("_", " ")}
            </span>
          </div>

          <dl className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ProjectDetailCard label="Active profile">
              {selectedProfile}
            </ProjectDetailCard>
            <ProjectDetailCard label="Routing source">
              {githubManagement.selectedSource}
            </ProjectDetailCard>
            <ProjectDetailCard label="Mode">
              {githubManagement.mode}
            </ProjectDetailCard>
            <ProjectDetailCard label="Installation">
              {installationSummary}
            </ProjectDetailCard>
            <ProjectDetailCard label="GitHub account">
              {selectedAccount}
            </ProjectDetailCard>
            <ProjectDetailCard label="Token source">
              {githubManagement.tokenResolved
                ? (githubManagement.tokenSource ?? "resolved")
                : "not resolved"}
            </ProjectDetailCard>
          </dl>

          <div className="grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="font-medium text-sm text-white">
              Repo-bound status command
            </p>
            <code className="rounded-2xl bg-slate-950/70 px-4 py-3 text-sm text-white/85">
              {githubManagement.statusCommand}
            </code>
            <p className="text-sm text-white/65 leading-6">
              Compare this UI with the same repo-bound status payload the CLI
              uses for GitHub routing checks.
            </p>
          </div>

          {githubManagement.readiness.repairGuidance.length > 0 ? (
            <section className="grid gap-3 rounded-2xl border border-amber-300/20 bg-amber-500/10 p-4">
              <p className="font-medium text-amber-100 text-sm">
                Repair guidance
              </p>
              <ul className="grid gap-3">
                {githubManagement.readiness.repairGuidance.map((guidance) => (
                  <li
                    className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                    key={`${guidance.issue}-${guidance.title}`}
                  >
                    <p className="font-medium text-white">{guidance.title}</p>
                    <p className="mt-2 text-sm text-white/75 leading-6">
                      {guidance.action}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </section>

        <section
          className={cn(sectionSurfaceClassName, "space-y-4 p-6 sm:p-7")}
        >
          <div className="space-y-2">
            <h3 className="font-medium text-white text-xl">
              Available profiles
            </h3>
            <p className="text-sm text-white/70 leading-6">
              The routed project profile, default profile, and saved GitHub
              account metadata all stay visible so repair work can target the
              correct configuration quickly.
            </p>
          </div>

          <dl className="grid gap-3">
            <ProjectDetailCard label="Default profile">
              {githubManagement.defaultProfile}
            </ProjectDetailCard>
            <ProjectDetailCard label="Project override">
              {githubManagement.projectOverride ?? "No project override"}
            </ProjectDetailCard>
            <ProjectDetailCard label="Extension enabled">
              {githubManagement.extensionEnabled ? "yes" : "no"}
            </ProjectDetailCard>
          </dl>

          {githubManagement.profiles.length > 0 ? (
            <ul className="grid gap-3">
              {githubManagement.profiles.map((profile) => {
                const selected =
                  profile.id === githubManagement.selectedProfile;
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
                          {profile.mode} •{" "}
                          {profile.accountLogin ?? "No account snapshot"}
                        </p>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
                        {profileStateLabel}
                      </span>
                    </div>
                    <dl className="mt-4 grid gap-3 md:grid-cols-2">
                      <ProjectDetailCard label="Auth ref">
                        {profile.authRef}
                      </ProjectDetailCard>
                      <ProjectDetailCard label="Installation">
                        {profile.installationId ?? "Not selected"}
                      </ProjectDetailCard>
                    </dl>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-white/70 leading-6">
              No GitHub profiles are configured for this repo yet.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

function CreateOrganizationCard(input: {
  readonly authenticated: boolean;
  readonly returnToPath: string;
}) {
  return (
    <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
      <div className="space-y-2">
        <h3 className="font-medium text-white text-xl">Create organization</h3>
        <p className="text-sm text-white/70 leading-6">
          New organizations immediately make the creator the first active member
          visible in the shared admin surface.
        </p>
      </div>

      {input.authenticated ? (
        <form
          action="/api/control-plane/orgs"
          className="mt-6 grid gap-4"
          method="post"
        >
          <input name="redirectTo" type="hidden" value={input.returnToPath} />

          <label className="grid gap-2">
            <span className="font-medium text-sm text-white/80">Slug</span>
            <input
              className={fieldClassName}
              name="slug"
              placeholder="hack-org"
              required
              type="text"
            />
          </label>

          <label className="grid gap-2">
            <span className="font-medium text-sm text-white/80">
              Display name
            </span>
            <input
              className={fieldClassName}
              name="name"
              placeholder="Hack Org"
              type="text"
            />
          </label>

          <button className={actionClassName} type="submit">
            Create organization
          </button>
        </form>
      ) : (
        <p className="mt-6 text-sm text-white/70 leading-6">
          Sign in first to create shared organizations from the browser control
          plane.
        </p>
      )}
    </section>
  );
}

function OrganizationsCard(input: {
  readonly account: AccountShellContext;
  readonly returnToPath: string;
  readonly scopedReturnPath: string;
}) {
  if (!input.account.authenticated) {
    return (
      <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
        <h3 className="font-medium text-white text-xl">
          Visible organizations
        </h3>
        <p className="mt-3 text-sm text-white/70 leading-6">
          Sign in to view the organizations and shared members available to the
          current caller.
        </p>
      </section>
    );
  }

  const selectedOrganization = input.account.selectedOrganization;
  const selectedOrganizationId = selectedOrganization?.id ?? null;
  const shouldShowVisibilityMessage = Boolean(
    input.account.requestedOrganizationKey &&
      !input.account.selectedOrganizationVisible &&
      !selectedOrganization
  );

  return (
    <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h3 className="font-medium text-white text-xl">
            Visible organizations
          </h3>
          <p className="text-sm text-white/70 leading-6">
            The broker returns only organizations visible to this account, and
            the detail panel below stays scoped to that same set.
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-white/70">
          {input.account.organizations.length} visible
        </span>
      </div>

      {input.account.organizations.length > 0 ? (
        <ul className="mt-6 grid gap-3">
          {input.account.organizations.map((organization) => {
            const selected = selectedOrganizationId === organization.id;
            return (
              <li key={organization.id}>
                <a
                  className={cn(
                    "block rounded-2xl border px-4 py-4 transition duration-200 motion-reduce:transition-none",
                    selected
                      ? "border-sky-300/35 bg-sky-300/10"
                      : "border-white/10 bg-slate-950/40 hover:bg-white/5",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
                  )}
                  href={buildAccountControlPlanePath({
                    redirectTo: input.returnToPath,
                    org: organization.slug,
                  })}
                >
                  <span className="block font-medium text-white">
                    {organization.name}
                  </span>
                  <span className="mt-1 block text-sm text-white/60">
                    {organization.slug}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-white/70 leading-6">
          No shared organizations are visible yet. Create one above or accept an
          invitation from another admin.
        </p>
      )}

      {selectedOrganization ? (
        <SelectedOrganizationDetail
          account={input.account}
          returnToPath={input.scopedReturnPath}
        />
      ) : null}

      {shouldShowVisibilityMessage ? (
        <div className="mt-6 rounded-2xl border border-sky-300/20 bg-sky-300/10 p-4">
          <p className="font-medium text-sky-100 text-sm">
            Requested organization not visible
          </p>
          <p className="mt-2 text-sm text-white/75 leading-6">
            This account cannot load the requested organization detail because
            it is not part of the caller-scoped org list.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function SelectedOrganizationDetail(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
  readonly returnToPath: string;
}) {
  const selectedOrganization = input.account.selectedOrganization;
  if (!selectedOrganization) {
    return null;
  }

  return (
    <div className="mt-6 space-y-6 rounded-2xl border border-white/10 bg-slate-950/35 p-5">
      <div className="space-y-2">
        <p className="font-medium text-sky-100 text-sm">Organization detail</p>
        <h4 className="font-semibold text-2xl text-white">
          {selectedOrganization.name}
        </h4>
        <p className="text-sm text-white/70 leading-6">
          Pending access stays pending until the intended principal accepts or
          declines it. Admin-side revoke uses the same broker route for pending
          and active org membership, while team-specific revoke stays scoped to
          the selected team below.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <h5 className="font-medium text-lg text-white">Invite member</h5>
          <form
            action={`/api/control-plane/orgs/${encodeURIComponent(selectedOrganization.slug)}/members/invite`}
            className="grid gap-4"
            method="post"
          >
            <input name="redirectTo" type="hidden" value={input.returnToPath} />

            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">
                Recipient email
              </span>
              <input
                className={fieldClassName}
                name="target"
                placeholder="person@example.com"
                required
                type="email"
              />
            </label>

            <button className={actionClassName} type="submit">
              Send pending invite
            </button>
          </form>
        </section>

        <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="space-y-2">
            <h5 className="font-medium text-lg text-white">
              Members and invites
            </h5>
            <p className="text-sm text-white/70 leading-6">
              Active members can manage the org. Pending recipients must accept
              or decline before access becomes active.
            </p>
          </div>

          {input.account.selectedOrganizationMemberships.length > 0 ? (
            <ul className="grid gap-3">
              {input.account.selectedOrganizationMemberships.map(
                (membership) => {
                  const isCurrentUser =
                    membership.userId === input.account.user.id ||
                    (membership.email &&
                      membership.email === input.account.user.email);
                  const targetLabel = membership.email ?? membership.target;
                  return (
                    <li
                      className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                      key={membership.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-2">
                          <p className="font-medium text-white">
                            {targetLabel}
                          </p>
                          <p className="text-sm text-white/70 leading-6">
                            {describeMembershipState({
                              state: membership.state,
                            })}
                          </p>
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
                          {membership.state}
                        </span>
                      </div>

                      {!isCurrentUser && membership.state !== "removed" ? (
                        <form
                          action={`/api/control-plane/orgs/${encodeURIComponent(selectedOrganization.slug)}/members/remove`}
                          className="mt-4"
                          method="post"
                        >
                          <input
                            name="redirectTo"
                            type="hidden"
                            value={input.returnToPath}
                          />
                          <input
                            name="target"
                            type="hidden"
                            value={membershipTargetValue({ membership })}
                          />
                          <button
                            className={secondaryActionClassName}
                            type="submit"
                          >
                            {membership.state === "pending"
                              ? "Revoke invite"
                              : "Remove member"}
                          </button>
                        </form>
                      ) : null}
                    </li>
                  );
                }
              )}
            </ul>
          ) : (
            <p className="text-sm text-white/70 leading-6">
              No actionable memberships are visible for this organization yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function TeamsSection(input: {
  readonly account: AccountShellContext;
  readonly returnToPath: string;
}) {
  if (!input.account.authenticated) {
    return (
      <section className="space-y-4" id="teams">
        <div className="space-y-2">
          <h2 className="font-semibold text-2xl text-white">Teams</h2>
          <p className="max-w-3xl text-sm text-white/70 leading-7">
            Sign in to manage explicit parent-org team scope from the browser
            control plane.
          </p>
        </div>

        <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
          <p className="text-sm text-white/70 leading-6">
            Team creation and membership changes stay hidden until this account
            has a signed-in broker session.
          </p>
        </section>
      </section>
    );
  }

  const selectedOrganization = input.account.selectedOrganization;
  if (!selectedOrganization) {
    return (
      <section className="space-y-4" id="teams">
        <div className="space-y-2">
          <h2 className="font-semibold text-2xl text-white">Teams</h2>
          <p className="max-w-3xl text-sm text-white/70 leading-7">
            Team creation and membership changes always require an explicit
            parent organization scope.
          </p>
        </div>

        <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
          <p className="text-sm text-white/70 leading-6">
            Select a visible organization first. Hack only shows teams and
            team-scoped resources when the current account belongs to them
            directly.
          </p>
        </section>
      </section>
    );
  }

  const selectedTeam = input.account.selectedTeam;
  const selectedTeamId = selectedTeam?.id ?? null;
  const scopedReturnPath = buildAccountControlPlanePath({
    redirectTo: input.returnToPath,
    org: selectedOrganization.slug,
    team: selectedTeam?.slug ?? input.account.requestedTeamKey,
  });
  const shouldShowVisibilityMessage = Boolean(
    input.account.requestedTeamKey &&
      !input.account.selectedTeamVisible &&
      selectedOrganization
  );

  return (
    <section className="space-y-4" id="teams">
      <div className="space-y-2">
        <h2 className="font-semibold text-2xl text-white">Teams</h2>
        <p className="max-w-3xl text-sm text-white/70 leading-7">
          Team creation and membership changes stay anchored to the explicit
          parent organization{" "}
          <code className="rounded bg-white/8 px-1.5 py-0.5 text-white text-xs">
            {selectedOrganization.slug}
          </code>
          . Org-only members cannot administer or load team-scoped resources
          until they join the team directly.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <CreateTeamCard
          organizationSlug={selectedOrganization.slug}
          returnToPath={scopedReturnPath}
        />

        <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <h3 className="font-medium text-white text-xl">Visible teams</h3>
              <p className="text-sm text-white/70 leading-6">
                Hack only lists teams that the current account can use inside
                the selected organization.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-white/70">
              {input.account.teams.length} visible
            </span>
          </div>

          {input.account.teams.length > 0 ? (
            <ul className="mt-6 grid gap-3">
              {input.account.teams.map((team) => {
                const selected = selectedTeamId === team.id;
                return (
                  <li key={team.id}>
                    <a
                      className={cn(
                        "block rounded-2xl border px-4 py-4 transition duration-200 motion-reduce:transition-none",
                        selected
                          ? "border-sky-300/35 bg-sky-300/10"
                          : "border-white/10 bg-slate-950/40 hover:bg-white/5",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
                      )}
                      href={buildAccountControlPlanePath({
                        redirectTo: input.returnToPath,
                        org: selectedOrganization.slug,
                        team: team.slug,
                      })}
                    >
                      <span className="block font-medium text-white">
                        {team.name}
                      </span>
                      <span className="mt-1 block text-sm text-white/60">
                        {team.slug}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-6 text-sm text-white/70 leading-6">
              No teams are visible for this organization yet. Create one above
              or add this account to an existing team first.
            </p>
          )}

          {selectedTeam ? (
            <SelectedTeamDetail
              account={input.account}
              returnToPath={scopedReturnPath}
            />
          ) : null}

          {shouldShowVisibilityMessage ? (
            <div className="mt-6 rounded-2xl border border-sky-300/20 bg-sky-300/10 p-4">
              <p className="font-medium text-sky-100 text-sm">
                Requested team not visible
              </p>
              <p className="mt-2 text-sm text-white/75 leading-6">
                This account cannot load the requested team because Hack only
                exposes team-scoped resources to direct team members.
              </p>
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function CreateTeamCard(input: {
  readonly organizationSlug: string;
  readonly returnToPath: string;
}) {
  return (
    <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
      <div className="space-y-2">
        <h3 className="font-medium text-white text-xl">Create team</h3>
        <p className="text-sm text-white/70 leading-6">
          Every team stays nested under one explicit parent organization so the
          scope never becomes ambiguous.
        </p>
      </div>

      <form
        action="/api/control-plane/teams"
        className="mt-6 grid gap-4"
        method="post"
      >
        <input name="redirectTo" type="hidden" value={input.returnToPath} />
        <input name="org" type="hidden" value={input.organizationSlug} />

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">Slug</span>
          <input
            className={fieldClassName}
            name="slug"
            placeholder="infra"
            required
            type="text"
          />
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">
            Display name
          </span>
          <input
            className={fieldClassName}
            name="name"
            placeholder="Infrastructure"
            type="text"
          />
        </label>

        <button className={actionClassName} type="submit">
          Create team
        </button>
      </form>
    </section>
  );
}

function SelectedTeamDetail(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
  readonly returnToPath: string;
}) {
  const selectedOrganization = input.account.selectedOrganization;
  const selectedTeam = input.account.selectedTeam;
  if (!(selectedOrganization && selectedTeam)) {
    return null;
  }

  return (
    <div className="mt-6 space-y-6 rounded-2xl border border-white/10 bg-slate-950/35 p-5">
      <div className="space-y-2">
        <p className="font-medium text-sky-100 text-sm">Team detail</p>
        <h4 className="font-semibold text-2xl text-white">
          {selectedTeam.name}
        </h4>
        <p className="text-sm text-white/70 leading-6">
          Members keep their parent organization access when a team-specific
          revoke happens. Team invites only succeed when the recipient already
          has active access to{" "}
          <code className="rounded bg-white/8 px-1.5 py-0.5 text-white text-xs">
            {selectedOrganization.slug}
          </code>
          .
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <h5 className="font-medium text-lg text-white">Invite member</h5>
          <form
            action={`/api/control-plane/teams/${encodeURIComponent(selectedTeam.slug)}/members/invite`}
            className="grid gap-4"
            method="post"
          >
            <input name="redirectTo" type="hidden" value={input.returnToPath} />
            <input name="org" type="hidden" value={selectedOrganization.slug} />

            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">
                Recipient email
              </span>
              <input
                className={fieldClassName}
                name="target"
                placeholder="person@example.com"
                required
                type="email"
              />
            </label>

            <button className={actionClassName} type="submit">
              Send team invite
            </button>
          </form>
        </section>

        <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="space-y-2">
            <h5 className="font-medium text-lg text-white">
              Members and revokes
            </h5>
            <p className="text-sm text-white/70 leading-6">
              Team revoke stays team-scoped. Removing one of these entries does
              not remove the member from the parent organization.
            </p>
          </div>

          {input.account.selectedTeamMemberships.length > 0 ? (
            <ul className="grid gap-3">
              {input.account.selectedTeamMemberships.map((membership) => {
                const isCurrentUser =
                  membership.userId === input.account.user.id ||
                  (membership.email &&
                    membership.email === input.account.user.email);
                const targetLabel = membership.email ?? membership.target;
                return (
                  <li
                    className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                    key={membership.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <p className="font-medium text-white">{targetLabel}</p>
                        <p className="text-sm text-white/70 leading-6">
                          {describeTeamMembershipState({
                            state: membership.state,
                          })}
                        </p>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
                        {membership.state}
                      </span>
                    </div>

                    {!isCurrentUser && membership.state !== "removed" ? (
                      <form
                        action={`/api/control-plane/teams/${encodeURIComponent(selectedTeam.slug)}/members/remove`}
                        className="mt-4"
                        method="post"
                      >
                        <input
                          name="redirectTo"
                          type="hidden"
                          value={input.returnToPath}
                        />
                        <input
                          name="org"
                          type="hidden"
                          value={selectedOrganization.slug}
                        />
                        <input
                          name="target"
                          type="hidden"
                          value={membershipTargetValue({ membership })}
                        />
                        <button
                          className={secondaryActionClassName}
                          type="submit"
                        >
                          {membership.state === "pending"
                            ? "Revoke invite"
                            : "Remove member"}
                        </button>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-white/70 leading-6">
              No direct team memberships are visible for this team yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function ProjectsSection(input: {
  readonly account: AccountShellContext;
  readonly returnToPath: string;
}) {
  if (!input.account.authenticated) {
    return (
      <section className="space-y-4" id="projects">
        <div className="space-y-2">
          <h2 className="font-semibold text-2xl text-white">Projects</h2>
          <p className="max-w-3xl text-sm text-white/70 leading-7">
            Sign in to register shared projects and review caller-scoped access
            grants from the browser control plane.
          </p>
        </div>

        <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
          <p className="text-sm text-white/70 leading-6">
            Shared project ownership and access controls stay hidden until this
            account has a signed-in broker session.
          </p>
        </section>
      </section>
    );
  }

  const account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  > = input.account;
  const selectedProject = account.selectedProject;
  const scopedReturnPath = buildAccountControlPlanePath({
    redirectTo: input.returnToPath,
    org: account.selectedOrganization?.slug ?? account.requestedOrganizationKey,
    team: account.selectedTeam?.slug ?? account.requestedTeamKey,
    project: selectedProject?.slug ?? account.requestedProjectKey,
  });
  const shouldShowVisibilityMessage = Boolean(
    account.requestedProjectKey &&
      !account.selectedProjectVisible &&
      !selectedProject
  );

  return (
    <section className="space-y-4" id="projects">
      <div className="space-y-2">
        <h2 className="font-semibold text-2xl text-white">Projects</h2>
        <p className="max-w-3xl text-sm text-white/70 leading-7">
          Register projects with explicit local or shared ownership and keep
          durable access grants visible from the same caller-scoped browser
          surface.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <RegisterProjectCard
          account={account}
          returnToPath={scopedReturnPath}
        />

        <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <h3 className="font-medium text-white text-xl">
                Visible projects
              </h3>
              <p className="text-sm text-white/70 leading-6">
                Hack only lists projects the current account can see through
                durable ownership or explicit project access grants.
              </p>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-white/70">
              {account.projects.length} visible
            </span>
          </div>

          {account.projects.length > 0 ? (
            <ul className="mt-6 grid gap-3">
              {account.projects.map((project) => {
                const selected = selectedProject?.id === project.id;
                return (
                  <li key={project.id}>
                    <a
                      className={cn(
                        "block rounded-2xl border px-4 py-4 transition duration-200 motion-reduce:transition-none",
                        selected
                          ? "border-sky-300/35 bg-sky-300/10"
                          : "border-white/10 bg-slate-950/40 hover:bg-white/5",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 focus-visible:outline-offset-2"
                      )}
                      href={buildAccountControlPlanePath({
                        redirectTo: input.returnToPath,
                        org:
                          account.selectedOrganization?.slug ??
                          account.requestedOrganizationKey,
                        team:
                          account.selectedTeam?.slug ??
                          account.requestedTeamKey,
                        project: project.slug,
                      })}
                    >
                      <span className="block font-medium text-white">
                        {project.name}
                      </span>
                      <span className="mt-1 block text-sm text-white/60">
                        {project.slug}
                      </span>
                      <span className="mt-2 block text-white/55 text-xs uppercase tracking-[0.18em]">
                        {project.ownership.mode} • {project.currentAccessRole}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-6 text-sm text-white/70 leading-6">
              No projects are visible yet. Register one with explicit local or
              shared ownership, or wait for an admin to grant this account
              access.
            </p>
          )}

          {selectedProject ? (
            <SelectedProjectDetail
              account={account}
              returnToPath={scopedReturnPath}
            />
          ) : null}

          {shouldShowVisibilityMessage ? (
            <div className="mt-6 rounded-2xl border border-sky-300/20 bg-sky-300/10 p-4">
              <p className="font-medium text-sky-100 text-sm">
                Requested project not visible
              </p>
              <p className="mt-2 text-sm text-white/75 leading-6">
                This account cannot load the requested project because Hack only
                exposes shared projects through durable ownership or explicit
                access grants.
              </p>
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function RegisterProjectCard(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
  readonly returnToPath: string;
}) {
  const scopedOrganizations = filterOrganizationsByActiveScope({
    account: input.account,
  });
  const scopedTeams = filterTeamsByActiveScope({
    account: input.account,
  });
  const selectedOrganizationSlug =
    scopedOrganizations[0]?.slug ??
    input.account.selectedOrganization?.slug ??
    "";
  const selectedTeamSlug =
    scopedTeams[0]?.slug ?? input.account.selectedTeam?.slug ?? "";
  const defaultMode = resolveDefaultProjectOwnershipMode({
    organizations: scopedOrganizations,
    teams: scopedTeams,
  });

  return (
    <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
      <div className="space-y-2">
        <h3 className="font-medium text-white text-xl">Register project</h3>
        <p className="text-sm text-white/70 leading-6">
          Shared registrations stay durable in the broker, while local mode
          remains explicit so CLI and web can report the same ownership state.
        </p>
        <p className="text-sm text-white/60 leading-6">
          Shared ownership choices follow the active Hack scope:{" "}
          {describeSharedProjectScope({ account: input.account })}.
        </p>
      </div>

      <form
        action="/api/control-plane/projects"
        className="mt-6 grid gap-4"
        method="post"
      >
        <input name="redirectTo" type="hidden" value={input.returnToPath} />

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">Slug</span>
          <input
            className={fieldClassName}
            name="slug"
            placeholder="hack-cli"
            required
            type="text"
          />
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">
            Display name
          </span>
          <input
            className={fieldClassName}
            name="name"
            placeholder="Hack CLI"
            type="text"
          />
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">
            Ownership mode
          </span>
          <select
            className={fieldClassName}
            defaultValue={defaultMode}
            name="mode"
          >
            <option value="local">Local</option>
            <option
              disabled={scopedOrganizations.length === 0}
              value="organization"
            >
              Organization
            </option>
            <option disabled={scopedTeams.length === 0} value="team">
              Team
            </option>
          </select>
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">
            Organization
          </span>
          <select
            className={fieldClassName}
            defaultValue={selectedOrganizationSlug}
            name="org"
          >
            <option value="">No organization</option>
            {scopedOrganizations.map((organization) => (
              <option key={organization.id} value={organization.slug}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-2">
          <span className="font-medium text-sm text-white/80">Team</span>
          <select
            className={fieldClassName}
            defaultValue={selectedTeamSlug}
            name="team"
          >
            <option value="">No team</option>
            {scopedTeams.map((team) => (
              <option key={team.id} value={team.slug}>
                {team.name}
              </option>
            ))}
          </select>
        </label>

        <button className={actionClassName} type="submit">
          Register project
        </button>
      </form>
    </section>
  );
}

function SelectedProjectDetail(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
  readonly returnToPath: string;
}) {
  const selectedProject = input.account.selectedProject;
  if (!selectedProject) {
    return null;
  }
  const scopedOrganizations = filterOrganizationsByActiveScope({
    account: input.account,
  });
  const scopedTeams = filterTeamsByActiveScope({
    account: input.account,
  });
  const organizationGrantDisabled = scopedOrganizations.length === 0;
  const teamGrantDisabled =
    scopedOrganizations.length === 0 || scopedTeams.length === 0;

  return (
    <div className="mt-6 space-y-6 rounded-2xl border border-white/10 bg-slate-950/35 p-5">
      <div className="space-y-2">
        <p className="font-medium text-sky-100 text-sm">Project detail</p>
        <h4 className="font-semibold text-2xl text-white">
          {selectedProject.name}
        </h4>
        <p className="text-sm text-white/70 leading-6">
          Ownership remains explicit:{" "}
          <span className="font-medium text-white">
            {selectedProject.ownership.mode}
          </span>{" "}
          managed by{" "}
          <span className="font-medium text-white">
            {selectedProject.ownership.ownerName ??
              selectedProject.ownership.ownerSlug ??
              selectedProject.ownership.ownerType}
          </span>
          .
        </p>
      </div>

      <dl className="grid gap-4 md:grid-cols-3">
        <ProjectDetailCard label="Ownership">
          {selectedProject.ownership.mode}
        </ProjectDetailCard>
        <ProjectDetailCard label="Owner">
          {selectedProject.ownership.ownerName ??
            selectedProject.ownership.ownerSlug ??
            selectedProject.ownership.ownerType}
        </ProjectDetailCard>
        <ProjectDetailCard label="Current role">
          {selectedProject.currentAccessRole}
        </ProjectDetailCard>
      </dl>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <h5 className="font-medium text-lg text-white">Explicit access</h5>
          <p className="text-sm text-white/70 leading-6">
            Shared grant targets follow the active Hack scope:{" "}
            {describeSharedProjectScope({ account: input.account })}.
          </p>
          <form
            action={`/api/control-plane/projects/${encodeURIComponent(selectedProject.slug)}/access/grant`}
            className="grid gap-4"
            method="post"
          >
            <input name="redirectTo" type="hidden" value={input.returnToPath} />

            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">
                Grant organization access
              </span>
              <select
                className={fieldClassName}
                disabled={organizationGrantDisabled}
                name="org"
              >
                <option value="">Choose organization</option>
                {scopedOrganizations.map((organization) => (
                  <option key={organization.id} value={organization.slug}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
            <input name="scope" type="hidden" value="organization" />
            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">Role</span>
              <select
                className={fieldClassName}
                defaultValue="viewer"
                disabled={organizationGrantDisabled}
                name="role"
              >
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button
              className={secondaryActionClassName}
              disabled={organizationGrantDisabled}
              type="submit"
            >
              Grant organization access
            </button>
          </form>

          <form
            action={`/api/control-plane/projects/${encodeURIComponent(selectedProject.slug)}/access/grant`}
            className="grid gap-4"
            method="post"
          >
            <input name="redirectTo" type="hidden" value={input.returnToPath} />
            <input name="scope" type="hidden" value="team" />
            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">
                Grant team access
              </span>
              <select
                className={fieldClassName}
                disabled={teamGrantDisabled}
                name="team"
              >
                <option value="">Choose team</option>
                {scopedTeams.map((team) => (
                  <option key={team.id} value={team.slug}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">
                Parent organization
              </span>
              <select
                className={fieldClassName}
                defaultValue={scopedOrganizations[0]?.slug ?? ""}
                disabled={teamGrantDisabled}
                name="org"
              >
                <option value="">Choose organization</option>
                {scopedOrganizations.map((organization) => (
                  <option key={organization.id} value={organization.slug}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-2">
              <span className="font-medium text-sm text-white/80">Role</span>
              <select
                className={fieldClassName}
                defaultValue="viewer"
                disabled={teamGrantDisabled}
                name="role"
              >
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button
              className={secondaryActionClassName}
              disabled={teamGrantDisabled}
              type="submit"
            >
              Grant team access
            </button>
          </form>
        </section>

        <section className="grid gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="space-y-2">
            <h5 className="font-medium text-lg text-white">Access grants</h5>
            <p className="text-sm text-white/70 leading-6">
              Shared project access remains explicit and removable per grant.
            </p>
          </div>

          {input.account.selectedProjectAccess.length > 0 ? (
            <ul className="grid gap-3">
              {input.account.selectedProjectAccess.map((grant) => (
                <li
                  className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
                  key={grant.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <p className="font-medium text-white">
                        {grant.subjectName}
                      </p>
                      <p className="text-sm text-white/70 leading-6">
                        {grant.scope} • {grant.role}
                      </p>
                    </div>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/70 text-xs uppercase tracking-[0.18em]">
                      {grant.subjectSlug}
                    </span>
                  </div>

                  <form
                    action={`/api/control-plane/projects/${encodeURIComponent(selectedProject.slug)}/access/revoke`}
                    className="mt-4"
                    method="post"
                  >
                    <input
                      name="redirectTo"
                      type="hidden"
                      value={input.returnToPath}
                    />
                    <input name="grantId" type="hidden" value={grant.id} />
                    <button className={secondaryActionClassName} type="submit">
                      Revoke access
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-white/70 leading-6">
              No explicit grants are visible for this project yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function ProjectDetailCard(input: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <dt className="font-medium text-sky-100 text-sm">{input.label}</dt>
      <dd className="mt-2 text-sm text-white/80 leading-6">{input.children}</dd>
    </div>
  );
}

function formatEnvClassificationLabel(input: { readonly value: string }) {
  return input.value.replaceAll("_", " ");
}

function formatEnvVariableStorageLabel(input: {
  readonly variable: EnvManagementState["variables"][number];
}) {
  return `${input.variable.storage.kind} • ${input.variable.storage.backend}`;
}

function describeGitHubInstallation(input: {
  readonly githubManagement: GitHubManagementState;
}) {
  if (input.githubManagement.readiness.installation.state === "configured") {
    return input.githubManagement.installationId ?? "Configured";
  }
  if (input.githubManagement.readiness.installation.state === "missing") {
    return "Missing installation";
  }
  return "Not required in token mode";
}

function InvitationsCard(input: {
  readonly account: AccountShellContext;
  readonly returnToPath: string;
}) {
  if (!input.account.authenticated) {
    return (
      <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
        <p className="text-sm text-white/70 leading-6">
          Sign in to review invitations that are specifically pending for the
          current account email address.
        </p>
      </section>
    );
  }

  const incomingInvitations = input.account.incomingInvitations;

  return (
    <section className={cn(sectionSurfaceClassName, "p-6 sm:p-7")}>
      {incomingInvitations.length > 0 ? (
        <ul className="grid gap-3">
          {incomingInvitations.map((invitation) => (
            <li
              className="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
              key={invitation.id}
            >
              <div className="space-y-2">
                <p className="font-medium text-white">{invitation.email}</p>
                <p className="text-sm text-white/70 leading-6">
                  Pending {invitation.scope} invite for organization{" "}
                  <code className="rounded bg-white/8 px-1.5 py-0.5 text-white text-xs">
                    {invitation.organizationId}
                  </code>
                </p>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <form
                  action={`/api/control-plane/invitations/${encodeURIComponent(invitation.id)}/accept`}
                  method="post"
                >
                  <input
                    name="redirectTo"
                    type="hidden"
                    value={input.returnToPath}
                  />
                  <button className={actionClassName} type="submit">
                    Accept invite
                  </button>
                </form>
                <form
                  action={`/api/control-plane/invitations/${encodeURIComponent(invitation.id)}/decline`}
                  method="post"
                >
                  <input
                    name="redirectTo"
                    type="hidden"
                    value={input.returnToPath}
                  />
                  <button className={secondaryActionClassName} type="submit">
                    Decline invite
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-white/70 leading-6">
          No invitations are pending for this account right now.
        </p>
      )}
    </section>
  );
}

function IntegrationScopeCard(input: {
  readonly feedback: AccountControlPlaneFeedback;
}) {
  return (
    <section
      className={cn(
        sectionSurfaceClassName,
        "p-5",
        input.feedback.tone === "success" &&
          "border-emerald-300/30 bg-emerald-500/10",
        input.feedback.tone === "danger" && "border-rose-300/30 bg-rose-500/10",
        input.feedback.tone === "info" && "border-sky-300/30 bg-sky-500/10"
      )}
      role={input.feedback.tone === "danger" ? "alert" : "status"}
    >
      <p className="font-medium text-sky-100 text-sm">{input.feedback.title}</p>
      <p className="mt-3 text-sm text-white/80 leading-6">
        {input.feedback.body}
      </p>
    </section>
  );
}

function resolveSharedIntegrationScopeFeedback(input: {
  readonly account: AccountShellContext;
}): AccountControlPlaneFeedback | null {
  if (!input.account.authenticated) {
    return null;
  }

  if (
    input.account.requestedProjectKey &&
    input.account.selectedProjectVisible === false &&
    !input.account.selectedProject
  ) {
    return {
      tone: "danger",
      title: "Shared project scope denied",
      body: "The current org/team context does not expose the requested shared project. Switch back to a visible shared scope before treating GitHub or Linear state as broker-managed for this repo.",
    };
  }

  const selectedProject = input.account.selectedProject;
  if (!selectedProject) {
    return {
      tone: "info",
      title: "No visible project scope",
      body: "Select or register a visible project before comparing shared GitHub and Linear scope with the active org/team context.",
    };
  }

  if (selectedProject.ownership.mode === "local") {
    return {
      tone: "info",
      title: "Local project scope",
      body: "This repo currently uses local project ownership, so GitHub and Linear readiness here reflects repo-local state instead of shared org/team broker scope.",
    };
  }

  if (selectedProject.currentAccessRole === "viewer") {
    return {
      tone: "info",
      title: "Read-only shared project scope",
      body: "The active org/team can inspect shared integration state for this project, but broker-managed mutations stay blocked while the current access role remains viewer.",
    };
  }

  return {
    tone: "success",
    title: "Shared project scope active",
    body: "The active org/team can inspect and manage shared GitHub and Linear state for the selected project without crossing tenant boundaries.",
  };
}

function filterOrganizationsByActiveScope(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
}) {
  const activeOrganizationId = input.account.activeOrganization?.id ?? null;
  if (!activeOrganizationId) {
    return input.account.organizations;
  }
  return input.account.organizations.filter((organization) => {
    return organization.id === activeOrganizationId;
  });
}

function filterTeamsByActiveScope(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
}) {
  const activeTeamId = input.account.activeTeam?.id ?? null;
  if (activeTeamId) {
    return input.account.teams.filter((team) => team.id === activeTeamId);
  }
  return [];
}

function resolveDefaultProjectOwnershipMode(input: {
  readonly organizations: readonly { readonly id: string }[];
  readonly teams: readonly { readonly id: string }[];
}): "local" | "organization" | "team" {
  if (input.teams.length > 0) {
    return "team";
  }
  if (input.organizations.length > 0) {
    return "organization";
  }
  return "local";
}

function describeSharedProjectScope(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
}) {
  if (input.account.activeTeam?.name) {
    return `${input.account.activeTeam.name} team inside ${input.account.activeOrganization?.name ?? "the active organization"}`;
  }
  if (input.account.activeOrganization?.name) {
    return `${input.account.activeOrganization.name} organization`;
  }
  return "local user context";
}

function describeMembershipState(input: {
  readonly state: "pending" | "active" | "removed";
}) {
  if (input.state === "pending") {
    return "Pending recipient action";
  }
  if (input.state === "active") {
    return "Active org access";
  }
  return "Removed access";
}

function describeTeamMembershipState(input: {
  readonly state: "pending" | "active" | "removed";
}) {
  if (input.state === "pending") {
    return "Pending team invite";
  }
  if (input.state === "active") {
    return "Active team access";
  }
  return "Removed team access";
}

function membershipTargetValue(input: {
  readonly membership: {
    readonly userId: string | null;
    readonly email: string | null;
    readonly target: string;
  };
}) {
  return (
    input.membership.userId ?? input.membership.email ?? input.membership.target
  );
}
