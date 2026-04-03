import { AuthEntrypoint } from "@/components/auth-entrypoint";
import { getAuthoritativeWebAuthConfig } from "@/lib/auth-config";
import { hasAuthenticatedBrowserSession } from "@/lib/browser-auth-session";
import { redirect as navigate } from "@/lib/server-navigation";

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
    flowId && deviceCode ? false : await hasAuthenticatedBrowserSession();
  if (browserSessionAuthenticated && !(flowId && deviceCode) && !redirect) {
    navigate("/account");
  }

  return (
    <AuthEntrypoint
      appBaseUrl={config.appBaseUrl}
      authBrokerBaseUrl={config.authBrokerBaseUrl}
      betterAuthEnabled={config.betterAuth.enabled}
      betterAuthSource={config.betterAuthSource}
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
