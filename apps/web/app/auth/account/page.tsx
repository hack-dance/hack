import { AuthEntrypoint } from "@/src/components/auth-entrypoint";
import { getAuthoritativeWebAuthConfig } from "@/src/lib/auth-config";
import { hasAuthenticatedBrowserSession } from "@/src/lib/browser-auth-session";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AuthAccountPage({
  searchParams,
}: {
  readonly searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const config = await getAuthoritativeWebAuthConfig();
  const flowId = readSearchParam(params.flowId);
  const deviceCode = readSearchParam(params.deviceCode);
  const redirect = readSearchParam(params.redirect);
  const browserSessionAuthenticated =
    redirect && !(flowId && deviceCode)
      ? await hasAuthenticatedBrowserSession()
      : false;

  return (
    <AuthEntrypoint
      appBaseUrl={config.appBaseUrl}
      authBrokerBaseUrl={config.authBrokerBaseUrl}
      browserSessionAuthenticated={browserSessionAuthenticated}
      deviceCode={deviceCode}
      flowId={flowId}
      mode="account"
      providers={config.betterAuth.socialProviders}
      redirect={redirect}
      trustedOrigins={config.betterAuth.trustedOrigins}
    />
  );
}

function readSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
