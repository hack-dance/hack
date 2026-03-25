import { AuthEntrypoint } from "@/src/components/auth-entrypoint";
import { getWebAuthConfig } from "@/src/lib/auth-config";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AuthAccountPage({
  searchParams,
}: {
  readonly searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const config = getWebAuthConfig();

  return (
    <AuthEntrypoint
      appBaseUrl={config.appBaseUrl}
      authBrokerBaseUrl={config.authBrokerBaseUrl}
      deviceCode={readSearchParam(params.deviceCode)}
      flowId={readSearchParam(params.flowId)}
      mode="account"
      providers={config.contract.socialProviders}
      redirect={readSearchParam(params.redirect)}
      trustedOrigins={config.contract.trustedOrigins}
    />
  );
}

function readSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
