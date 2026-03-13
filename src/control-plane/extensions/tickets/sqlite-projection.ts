import { Database } from "bun:sqlite";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  TicketComment,
  TicketEvent,
  TicketReviewNote,
  TicketStoreSnapshot,
  TicketSummary,
  TicketSyncCheckpoint,
  TicketSyncConflict,
} from "./store.ts";
import { sha256Hex, stableStringify } from "./util.ts";

const PROJECTION_SCHEMA_VERSION = 1;

type ProjectionMetaRow = {
  readonly key: string;
  readonly value: string;
};

type ProjectionJsonRow = {
  readonly ticket_id: string;
  readonly json_value: string;
};

type ProjectionEventRow = {
  readonly ticket_id: string;
  readonly json_value: string;
  readonly ts: number;
  readonly order_key: string | null;
};

export function createTicketsSqliteProjection(opts: {
  readonly projectRoot: string;
}): {
  readonly computeJournalSignature: (input: {
    readonly ticketsRoot: string;
  }) => Promise<string>;
  readonly path: string;
  readonly readSnapshot: (input: {
    readonly journalSignature: string;
  }) => Promise<TicketStoreSnapshot | null>;
  readonly replaceSnapshot: (input: {
    readonly journalSignature: string;
    readonly snapshot: TicketStoreSnapshot;
  }) => Promise<void>;
} {
  const path = resolve(opts.projectRoot, ".hack/tickets/projection.sqlite");

  const computeJournalSignature = async (input: {
    readonly ticketsRoot: string;
  }): Promise<string> => {
    const eventsDir = resolve(input.ticketsRoot, ".hack/tickets/events");
    let entries: string[] = [];
    try {
      entries = (await readdir(eventsDir))
        .filter((entry) => entry.endsWith(".jsonl"))
        .sort();
    } catch {
      return sha256Hex({ value: "" });
    }

    const files = await Promise.all(
      entries.map(async (entry) => {
        const text = await Bun.file(resolve(eventsDir, entry))
          .text()
          .catch(() => "");
        return {
          entry,
          text,
        };
      })
    );

    return sha256Hex({
      value: stableStringify(
        files.map((file) => ({
          entry: file.entry,
          text: file.text,
        }))
      ),
    });
  };

  const replaceSnapshot = async (input: {
    readonly journalSignature: string;
    readonly snapshot: TicketStoreSnapshot;
  }): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
      initializeProjectionSchema({ db });

      const insertMeta = db.query(
        "INSERT INTO projection_meta (key, value) VALUES (?, ?)"
      );
      const insertTicket = db.query(
        "INSERT INTO tickets (ticket_id, title, updated_at, json_value) VALUES (?, ?, ?, ?)"
      );
      const insertEvent = db.query(
        "INSERT INTO journal_events (event_id, ticket_id, ts, order_key, event_type, idempotency_key, json_value) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const insertComment = db.query(
        "INSERT INTO ticket_comments (comment_id, ticket_id, json_value) VALUES (?, ?, ?)"
      );
      const insertReviewNote = db.query(
        "INSERT INTO ticket_review_notes (note_id, ticket_id, json_value) VALUES (?, ?, ?)"
      );
      const insertCheckpoint = db.query(
        "INSERT INTO ticket_sync_checkpoints (checkpoint_id, ticket_id, json_value) VALUES (?, ?, ?)"
      );
      const insertConflict = db.query(
        "INSERT INTO ticket_sync_conflicts (conflict_id, ticket_id, json_value) VALUES (?, ?, ?)"
      );

      const events = [...input.snapshot.eventsByTicket.values()].flat();

      const transaction = db.transaction(() => {
        db.exec(`
          DELETE FROM projection_meta;
          DELETE FROM tickets;
          DELETE FROM journal_events;
          DELETE FROM ticket_comments;
          DELETE FROM ticket_review_notes;
          DELETE FROM ticket_sync_checkpoints;
          DELETE FROM ticket_sync_conflicts;
        `);

        insertMeta.run("schema_version", String(PROJECTION_SCHEMA_VERSION));
        insertMeta.run("journal_signature", input.journalSignature);
        insertMeta.run("rebuilt_at", new Date().toISOString());

        for (const ticket of input.snapshot.tickets) {
          insertTicket.run(
            ticket.ticketId,
            ticket.title,
            ticket.updatedAt,
            JSON.stringify(ticket)
          );
        }

        for (const event of events) {
          insertEvent.run(
            event.eventId,
            event.ticketId,
            event.ts,
            event.orderKey ?? null,
            event.eventType,
            event.idempotencyKey,
            JSON.stringify(event)
          );
        }

        writeMapEntries({
          map: input.snapshot.commentsByTicket,
          write: (comment: TicketComment) => {
            insertComment.run(
              comment.commentId,
              comment.ticketId,
              JSON.stringify(comment)
            );
          },
        });

        writeMapEntries({
          map: input.snapshot.reviewNotesByTicket,
          write: (reviewNote: TicketReviewNote) => {
            insertReviewNote.run(
              reviewNote.noteId,
              reviewNote.ticketId,
              JSON.stringify(reviewNote)
            );
          },
        });

        writeMapEntries({
          map: input.snapshot.syncCheckpointsByTicket,
          write: (checkpoint: TicketSyncCheckpoint) => {
            insertCheckpoint.run(
              checkpoint.checkpointId,
              checkpoint.ticketId,
              JSON.stringify(checkpoint)
            );
          },
        });

        writeMapEntries({
          map: input.snapshot.conflictsByTicket,
          write: (conflict: TicketSyncConflict) => {
            insertConflict.run(
              conflict.conflictId,
              conflict.ticketId,
              JSON.stringify(conflict)
            );
          },
        });
      });

      transaction();
    } finally {
      db.close();
    }
  };

  const readSnapshot = async (input: {
    readonly journalSignature: string;
  }): Promise<TicketStoreSnapshot | null> => {
    if (!(await Bun.file(path).exists())) {
      return null;
    }

    const db = new Database(path);
    try {
      initializeProjectionSchema({ db });
      const metaRows = db
        .query("SELECT key, value FROM projection_meta")
        .all() as ProjectionMetaRow[];
      const meta = new Map(
        metaRows.map((row) => [row.key, row.value] as const)
      );
      if (
        meta.get("schema_version") !== String(PROJECTION_SCHEMA_VERSION) ||
        meta.get("journal_signature") !== input.journalSignature
      ) {
        return null;
      }

      const tickets = (
        db
          .query(
            "SELECT ticket_id, json_value FROM tickets ORDER BY CAST(SUBSTR(ticket_id, 3) AS INTEGER), ticket_id"
          )
          .all() as ProjectionJsonRow[]
      )
        .map((row) =>
          parseProjectionJson<TicketSummary>({ json: row.json_value })
        )
        .filter((ticket): ticket is TicketSummary => ticket !== null);

      const eventsByTicket = readEventRows({ db });
      const commentsByTicket = readRowsByTicket<TicketComment>({
        db,
        table: "ticket_comments",
      });
      const reviewNotesByTicket = readRowsByTicket<TicketReviewNote>({
        db,
        table: "ticket_review_notes",
      });
      const syncCheckpointsByTicket = readRowsByTicket<TicketSyncCheckpoint>({
        db,
        table: "ticket_sync_checkpoints",
      });
      const conflictsByTicket = readRowsByTicket<TicketSyncConflict>({
        db,
        table: "ticket_sync_conflicts",
      });

      return {
        tickets,
        eventsByTicket,
        commentsByTicket,
        reviewNotesByTicket,
        syncCheckpointsByTicket,
        conflictsByTicket,
      };
    } finally {
      db.close();
    }
  };

  return {
    computeJournalSignature,
    path,
    readSnapshot,
    replaceSnapshot,
  };
}

function initializeProjectionSchema(input: { readonly db: Database }): void {
  input.db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projection_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      json_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_events (
      event_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      order_key TEXT,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      json_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_comments (
      comment_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      json_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_review_notes (
      note_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      json_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_sync_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      json_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_sync_conflicts (
      conflict_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      json_value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS journal_events_ticket_id_idx
      ON journal_events (ticket_id, ts, order_key);
    CREATE INDEX IF NOT EXISTS ticket_comments_ticket_id_idx
      ON ticket_comments (ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_review_notes_ticket_id_idx
      ON ticket_review_notes (ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_sync_checkpoints_ticket_id_idx
      ON ticket_sync_checkpoints (ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_sync_conflicts_ticket_id_idx
      ON ticket_sync_conflicts (ticket_id);
  `);
}

function parseProjectionJson<T>(input: { readonly json: string }): T | null {
  try {
    return JSON.parse(input.json) as T;
  } catch {
    return null;
  }
}

function readEventRows(input: {
  readonly db: Database;
}): Map<string, TicketEvent[]> {
  const rows = input.db
    .query(
      "SELECT ticket_id, json_value, ts, order_key FROM journal_events ORDER BY ts, order_key, event_id"
    )
    .all() as ProjectionEventRow[];

  const grouped = new Map<string, TicketEvent[]>();
  for (const row of rows) {
    const event = parseProjectionJson<TicketEvent>({ json: row.json_value });
    if (!event) {
      continue;
    }
    const list = grouped.get(row.ticket_id) ?? [];
    list.push(event);
    grouped.set(row.ticket_id, list);
  }
  return grouped;
}

function readRowsByTicket<T>(input: {
  readonly db: Database;
  readonly table:
    | "ticket_comments"
    | "ticket_review_notes"
    | "ticket_sync_checkpoints"
    | "ticket_sync_conflicts";
}): Map<string, T[]> {
  const rows = input.db
    .query(
      `SELECT ticket_id, json_value FROM ${input.table} ORDER BY ticket_id, rowid`
    )
    .all() as ProjectionJsonRow[];

  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = parseProjectionJson<T>({ json: row.json_value });
    if (!value) {
      continue;
    }
    const list = grouped.get(row.ticket_id) ?? [];
    list.push(value);
    grouped.set(row.ticket_id, list);
  }
  return grouped;
}

function writeMapEntries<T>(input: {
  readonly map: ReadonlyMap<string, readonly T[]>;
  readonly write: (value: T) => void;
}): void {
  for (const values of input.map.values()) {
    for (const value of values) {
      input.write(value);
    }
  }
}
