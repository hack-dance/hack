import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function AccountPageFrame(input: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-medium text-2xl text-foreground tracking-tight">
          {input.title}
        </h1>
        <p className="max-w-3xl text-muted-foreground text-sm">
          {input.description}
        </p>
      </div>
      {input.children}
    </div>
  );
}

export function AccountSectionCard(input: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>{input.title}</CardTitle>
            {input.description ? (
              <CardDescription>{input.description}</CardDescription>
            ) : null}
          </div>
          {input.action ? <div>{input.action}</div> : null}
        </div>
      </CardHeader>
      <CardContent>{input.children}</CardContent>
    </Card>
  );
}

export function AccountEmptyState(input: {
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div className="border border-border border-dashed px-4 py-8 text-center">
      <p className="font-medium text-foreground text-sm">{input.title}</p>
      <p className="mt-2 text-muted-foreground text-sm">{input.body}</p>
    </div>
  );
}

export function AccountStatsGrid(input: {
  readonly items: readonly {
    readonly label: string;
    readonly value: string;
    readonly hint?: string;
  }[];
}) {
  return (
    <dl className="grid gap-px border border-border sm:grid-cols-2 xl:grid-cols-4">
      {input.items.map((item) => (
        <div className="bg-card p-4" key={item.label}>
          <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
            {item.label}
          </dt>
          <dd className="mt-3 font-medium text-2xl text-foreground">
            {item.value}
          </dd>
          {item.hint ? (
            <p className="mt-2 text-muted-foreground text-xs">{item.hint}</p>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
