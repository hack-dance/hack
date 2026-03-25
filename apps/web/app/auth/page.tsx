import { AuthEntrypoint } from "@/src/components/auth-entrypoint";
import { getAuthoritativeWebAuthConfig } from "@/src/lib/auth-config";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AuthPage({
  searchParams,
}: {
  readonly searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const config = await getAuthoritativeWebAuthConfig();

  return (
    <AuthEntrypoint
      appBaseUrl={config.appBaseUrl}
      authBrokerBaseUrl={config.authBrokerBaseUrl}
      deviceCode={readSearchParam(params.deviceCode)}
      flowId={readSearchParam(params.flowId)}
      mode="sign-in"
      providers={config.betterAuth.socialProviders}
      redirect={readSearchParam(params.redirect)}
      trustedOrigins={config.betterAuth.trustedOrigins}
    />
  );
}

function readSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
