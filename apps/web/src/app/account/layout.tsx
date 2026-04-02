import { AppShell } from "@/components/app-shell";

export default function AccountLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
