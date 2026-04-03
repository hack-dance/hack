import {
  AccountPageFrame,
  AccountSectionCard,
  AccountStatsGrid,
} from "@/components/account-page-frame";
import { loadEnvManagementState } from "@/lib/env-management";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function AccountSecretsPage() {
  const envManagement = await loadEnvManagementState();

  return (
    <AccountPageFrame
      description="Secrets stay grounded in the repo’s real env storage model, so the shell shows whether values are local-only, portable, mirrored, or missing."
      title="Secrets"
    >
      <AccountStatsGrid
        items={[
          {
            label: "Ready",
            value: envManagement.ready ? "Yes" : "No",
          },
          {
            label: "Selection",
            value: envManagement.envSelectionLabel,
          },
          {
            label: "Backend",
            value: envManagement.backend.name,
          },
          {
            label: "Missing",
            value: String(envManagement.missingRequired.length),
          },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <AccountSectionCard
          description={envManagement.status.detail}
          title={envManagement.status.summary}
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <SecretValue
              label="Trust model"
              value={envManagement.status.trustModel}
            />
            <SecretValue label="Custody" value={envManagement.status.custody} />
            <SecretValue
              label="Portability"
              value={envManagement.status.portability}
            />
            <SecretValue
              label="Shared state"
              value={envManagement.status.sharedState}
            />
          </dl>
        </AccountSectionCard>

        <AccountSectionCard
          description={envManagement.compatibilityMode.summary}
          title="Storage"
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <SecretValue
              label="Plaintext target"
              value={envManagement.compatibilityMode.plaintextTarget}
            />
            <SecretValue
              label="Secret backend"
              value={envManagement.compatibilityMode.secretBackend}
            />
            <SecretValue
              label="Portable status"
              value={envManagement.portableState.status}
            />
            <SecretValue
              label="Local plaintext"
              value={
                envManagement.localPlaintext.exists ? "Present" : "Missing"
              }
            />
          </dl>
        </AccountSectionCard>
      </div>
    </AccountPageFrame>
  );
}

function SecretValue(input: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
        {input.label}
      </dt>
      <dd className="mt-1 text-foreground">{input.value}</dd>
    </div>
  );
}
