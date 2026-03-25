import AccountShellPage from "@/src/components/account-shell-page";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function HomePage(input: {
  readonly searchParams?: SearchParams;
}) {
  return (
    <AccountShellPage returnToPath="/" searchParams={input.searchParams} />
  );
}
