import { sha256Hex } from "./util.ts";

export type TicketDocumentKind = "description" | "spec" | "notes";
export type TicketDocumentRole = TicketDocumentKind | "handoff";

export type TicketDocument = {
  readonly documentId: string;
  readonly ticketId: string;
  readonly kind: TicketDocumentKind;
  readonly role: TicketDocumentRole;
  readonly content: string;
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export function isTicketDocumentKind(
  value: string
): value is TicketDocumentKind {
  return ["description", "spec", "notes"].includes(value);
}

export function isTicketDocumentRole(
  value: string
): value is TicketDocumentRole {
  return ["description", "spec", "notes", "handoff"].includes(value);
}

export function resolveTicketDocumentRole(input: {
  readonly kind: TicketDocumentKind;
  readonly role?: TicketDocumentRole;
}): TicketDocumentRole {
  return input.role ?? input.kind;
}

export function buildTicketDocument(input: {
  readonly documentId: string;
  readonly ticketId: string;
  readonly kind: TicketDocumentKind;
  readonly role?: TicketDocumentRole;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TicketDocument {
  return {
    documentId: input.documentId,
    ticketId: input.ticketId,
    kind: input.kind,
    role: resolveTicketDocumentRole({
      kind: input.kind,
      role: input.role,
    }),
    content: input.content,
    contentSha256: sha256Hex({ value: input.content }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

export function buildLegacyDescriptionDocument(input: {
  readonly eventId: string;
  readonly ticketId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}): TicketDocument {
  return buildTicketDocument({
    documentId: `${input.ticketId}:description:${input.eventId}`,
    ticketId: input.ticketId,
    kind: "description",
    content: input.content,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

export function getActiveTicketDescription(input: {
  readonly documents: readonly TicketDocument[];
}): TicketDocument | undefined {
  for (let index = input.documents.length - 1; index >= 0; index -= 1) {
    const document = input.documents[index];
    if (document?.role === "description") {
      return document;
    }
  }
  return undefined;
}

export function projectTicketBodyFromDocuments(input: {
  readonly documents: readonly TicketDocument[];
  readonly fallbackBody?: string;
}): string | undefined {
  return (
    getActiveTicketDescription({ documents: input.documents })?.content ??
    input.fallbackBody
  );
}
