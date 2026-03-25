import AccountShellPage from "@/src/components/account-shell-page";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function AccountPage(input: {
  readonly searchParams?: SearchParams;
}) {
  return (
    <AccountShellPage
      returnToPath="/account"
      searchParams={input.searchParams}
    />
  );
}
