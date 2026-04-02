import { Suspense } from "react";

import AccountShellLoading from "@/components/account-shell-loading";
import AccountShellPage from "@/components/account-shell-page";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function AccountPage(input: {
  readonly searchParams?: SearchParams;
}) {
  return (
    <Suspense fallback={<AccountShellLoading />}>
      <AccountShellPage
        returnToPath="/account"
        searchParams={input.searchParams}
      />
    </Suspense>
  );
}
