import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Sign-up is the same OAuth path as sign-in; keep the route for old links.
 */
export default async function AuthSignUpPage({
  searchParams,
}: {
  readonly searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const query = buildQueryString(params);
  redirect(query.length > 0 ? `/auth?${query}` : "/auth");
}

function buildQueryString(
  record: Record<string, string | string[] | undefined>
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        searchParams.append(key, entry);
      }
    } else {
      searchParams.set(key, value);
    }
  }
  return searchParams.toString();
}
