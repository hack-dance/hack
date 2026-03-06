import XCTest

@testable import HackDesktopModels

final class TicketDetailReviewModelTests: XCTestCase {
  func testTicketDetailDecodesRicherSyncPayload() throws {
    let data = Data(
      #"""
      {
        "ticket": {
          "ticketId": "T-00042",
          "title": "Investigate sync drift",
          "body": "Imported from Linear.",
          "status": "in_progress",
          "createdAt": "2026-03-05T16:00:00Z",
          "updatedAt": "2026-03-05T17:00:00Z",
          "dependsOn": ["T-00001"],
          "blocks": ["T-00099"],
          "owner": "hack",
          "source": "hack",
          "assignee": "alice@hack",
          "tags": ["linear", "review"],
          "externalSystem": "linear",
          "externalId": "lin_issue_42",
          "externalKey": "ENG-42",
          "externalUrl": "https://linear.app/hack/issue/ENG-42",
          "externalProjectId": "proj-42",
          "externalProjectName": "Control Plane",
          "externalTeamId": "eng",
          "projectId": "local-project",
          "projectName": "Hack CLI"
        },
        "comments": [
          {
            "commentId": "c-1",
            "ticketId": "T-00042",
            "body": "Imported from Linear.",
            "source": "linear",
            "actor": "linear@app",
            "createdAt": "2026-03-05T16:10:00Z",
            "externalId": "linear-comment-1",
            "externalUrl": "https://linear.app/comment/1"
          },
          {
            "commentId": "c-2",
            "ticketId": "T-00042",
            "body": "Local follow-up.",
            "source": "hack",
            "actor": "alice@hack",
            "createdAt": "2026-03-05T16:20:00Z"
          }
        ],
        "syncCheckpoints": [
          {
            "checkpointId": "cp-1",
            "ticketId": "T-00042",
            "provider": "linear",
            "profileId": "default",
            "direction": "pull",
            "remoteCursor": "issue/ENG-42#v2",
            "remoteUpdatedAt": "2026-03-05T16:59:00Z",
            "localUpdatedAt": "2026-03-05T17:00:00Z",
            "actor": "sync@app",
            "createdAt": "2026-03-05T17:00:01Z"
          }
        ],
        "conflicts": [
          {
            "conflictId": "conflict-1",
            "ticketId": "T-00042",
            "provider": "linear",
            "field": "assignee",
            "status": "open",
            "authority": "origin",
            "summary": "Assignee diverged during pull.",
            "localValue": "alice@hack",
            "remoteValue": "bob@linear",
            "createdAt": "2026-03-05T17:00:02Z",
            "updatedAt": "2026-03-05T17:00:02Z"
          },
          {
            "conflictId": "conflict-2",
            "ticketId": "T-00042",
            "provider": "linear",
            "field": "labels",
            "status": "resolved",
            "authority": "mergeable",
            "summary": "Label translation reviewed.",
            "localValue": ["infra", "review"],
            "remoteValue": {"team": "Platform", "name": "infra"},
            "createdAt": "2026-03-05T16:40:00Z",
            "updatedAt": "2026-03-05T16:50:00Z",
            "resolution": "merged",
            "resolutionSummary": "Kept both labels.",
            "resolvedAt": "2026-03-05T16:50:00Z",
            "resolvedBy": "alice@hack"
          }
        ],
        "events": [
          {
            "eventId": "event-1",
            "ts": 1741190400,
            "tsIso": "2026-03-05T16:00:00Z",
            "actor": "creator@hack",
            "ticketId": "T-00042",
            "type": "ticket.created"
          }
        ]
      }
      """#.utf8
    )

    let decoder = JSONDecoder()
    let detail = try decoder.decode(TicketDetailResponse.self, from: data)

    XCTAssertEqual(detail.ticket.assignee, "alice@hack")
    XCTAssertEqual(detail.comments.count, 2)
    XCTAssertEqual(detail.syncCheckpoints.count, 1)
    XCTAssertEqual(detail.conflicts.count, 2)
    XCTAssertEqual(detail.latestSyncCheckpoint?.remoteCursor, "issue/ENG-42#v2")
    XCTAssertEqual(detail.openSyncConflicts.count, 1)
    XCTAssertEqual(detail.resolvedSyncConflicts.count, 1)
    XCTAssertEqual(detail.conflicts[0].localValue?.displayText, "alice@hack")
    XCTAssertEqual(detail.conflicts[1].remoteValue?.displayText, #"{"name":"infra","team":"Platform"}"#)
  }

  func testReviewStatePrioritizesOpenConflictsOverOwnershipHint() {
    let detail = makeDetail(
      ticket: makeTicketSummary(owner: "linear", source: "hack", assignee: "alice@hack"),
      comments: [
        TicketComment(
          commentId: "c-1",
          ticketId: "T-00042",
          body: "Imported from Linear.",
          source: "linear",
          actor: "linear@app",
          createdAt: "2026-03-05T16:10:00Z",
          externalId: "comment-1",
          externalUrl: nil
        )
      ],
      syncCheckpoints: [
        TicketSyncCheckpoint(
          checkpointId: "cp-1",
          ticketId: "T-00042",
          provider: "linear",
          profileId: "default",
          direction: "pull",
          remoteCursor: "issue/ENG-42#v2",
          remoteUpdatedAt: nil,
          localUpdatedAt: nil,
          actor: "sync@app",
          createdAt: "2026-03-05T17:00:01Z"
        )
      ],
      conflicts: [
        TicketSyncConflict(
          conflictId: "conflict-1",
          ticketId: "T-00042",
          provider: "linear",
          field: "assignee",
          status: .open,
          authority: "origin",
          summary: "Assignee diverged during pull.",
          localValue: .string("alice@hack"),
          remoteValue: .string("bob@linear"),
          createdAt: "2026-03-05T17:00:02Z",
          updatedAt: "2026-03-05T17:00:02Z",
          resolution: nil,
          resolutionSummary: nil,
          resolvedAt: nil,
          resolvedBy: nil
        )
      ]
    )

    let review = detail.linearSyncReviewState

    XCTAssertEqual(review.severity, .conflict)
    XCTAssertTrue(review.needsReview)
    XCTAssertEqual(review.badgeLabel, "1 open conflict")
    XCTAssertEqual(review.highlightedFields, ["assignee"])
    XCTAssertTrue(review.message.contains("Comments stay append-only"))
    XCTAssertTrue(review.message.contains("Last sync: pull via Linear"))
  }

  func testReviewStateUsesOwnershipHintWhenConflictLedgerIsEmpty() {
    let detail = makeDetail(
      ticket: makeTicketSummary(owner: "linear", source: "hack", assignee: nil),
      comments: [],
      syncCheckpoints: [],
      conflicts: []
    )

    let review = detail.linearSyncReviewState

    XCTAssertEqual(review.severity, .review)
    XCTAssertTrue(review.needsReview)
    XCTAssertEqual(review.badgeLabel, "Needs review")
    XCTAssertEqual(review.highlightedFields, ["assignee", "labels", "dependencies"])
    XCTAssertTrue(review.message.contains("Review assignee, labels, and dependencies before the next sync."))
  }

  func testReviewStateReportsCleanLinkedTicketWithCheckpointSummary() {
    let detail = makeDetail(
      ticket: makeTicketSummary(owner: "hack", source: "hack", assignee: "alice@hack"),
      comments: [
        TicketComment(
          commentId: "c-1",
          ticketId: "T-00042",
          body: "Local follow-up.",
          source: "hack",
          actor: "alice@hack",
          createdAt: "2026-03-05T16:20:00Z",
          externalId: nil,
          externalUrl: nil
        )
      ],
      syncCheckpoints: [
        TicketSyncCheckpoint(
          checkpointId: "cp-1",
          ticketId: "T-00042",
          provider: "linear",
          profileId: "default",
          direction: "push",
          remoteCursor: "issue/ENG-42#v3",
          remoteUpdatedAt: nil,
          localUpdatedAt: nil,
          actor: "sync@app",
          createdAt: "2026-03-05T17:00:01Z"
        )
      ],
      conflicts: []
    )

    let review = detail.linearSyncReviewState

    XCTAssertEqual(review.severity, .clear)
    XCTAssertFalse(review.needsReview)
    XCTAssertEqual(review.badgeLabel, "Ready")
    XCTAssertEqual(review.commentCount, 1)
    XCTAssertEqual(review.openConflictCount, 0)
    XCTAssertEqual(review.resolvedConflictCount, 0)
    XCTAssertEqual(review.checkpointSummary, "Last sync: push via Linear (profile default).")
  }

  func testReviewQueueEntryUsesDetailedReviewStateWhenAvailable() {
    let detail = makeDetail(
      ticket: makeTicketSummary(owner: "linear", source: "hack", assignee: "alice@hack"),
      comments: [
        TicketComment(
          commentId: "c-1",
          ticketId: "T-00042",
          body: "Imported from Linear.",
          source: "linear",
          actor: "linear@app",
          createdAt: "2026-03-05T16:10:00Z",
          externalId: "comment-1",
          externalUrl: nil
        )
      ],
      syncCheckpoints: [],
      conflicts: [
        TicketSyncConflict(
          conflictId: "conflict-1",
          ticketId: "T-00042",
          provider: "linear",
          field: "assignee",
          status: .open,
          authority: "origin",
          summary: "Assignee diverged during pull.",
          localValue: .string("alice@hack"),
          remoteValue: .string("bob@linear"),
          createdAt: "2026-03-05T17:00:02Z",
          updatedAt: "2026-03-05T17:00:02Z",
          resolution: nil,
          resolutionSummary: nil,
          resolvedAt: nil,
          resolvedBy: nil
        )
      ]
    )

    let entry = TicketReviewQueueEntry(ticket: detail.ticket, detail: detail, localNoteCount: 2)

    XCTAssertEqual(entry?.ticketId, detail.ticket.ticketId)
    XCTAssertEqual(entry?.badgeLabel, "1 open conflict")
    XCTAssertEqual(entry?.commentCount, 1)
    XCTAssertEqual(entry?.openConflictCount, 1)
    XCTAssertEqual(entry?.localNoteCount, 2)
  }

  func testReviewComposerDraftIncludesConflictAndLatestComment() {
    let detail = makeDetail(
      ticket: makeTicketSummary(owner: "linear", source: "hack", assignee: "alice@hack"),
      comments: [
        TicketComment(
          commentId: "c-1",
          ticketId: "T-00042",
          body: "Imported from Linear.",
          source: "linear",
          actor: "linear@app",
          createdAt: "2026-03-05T16:10:00Z",
          externalId: "comment-1",
          externalUrl: nil
        )
      ],
      syncCheckpoints: [],
      conflicts: [
        TicketSyncConflict(
          conflictId: "conflict-1",
          ticketId: "T-00042",
          provider: "linear",
          field: "assignee",
          status: .open,
          authority: "origin",
          summary: "Assignee diverged during pull.",
          localValue: .string("alice@hack"),
          remoteValue: .string("bob@linear"),
          createdAt: "2026-03-05T17:00:02Z",
          updatedAt: "2026-03-05T17:00:02Z",
          resolution: nil,
          resolutionSummary: nil,
          resolvedAt: nil,
          resolvedBy: nil
        )
      ]
    )

    let draft = TicketReviewComposer.draft(
      for: detail,
      highlightedConflict: detail.openSyncConflicts.first
    )

    XCTAssertTrue(draft.contains("Conflict to resolve:"))
    XCTAssertTrue(draft.contains("Field: assignee"))
    XCTAssertTrue(draft.contains("Hack: alice@hack"))
    XCTAssertTrue(draft.contains("Linear: bob@linear"))
    XCTAssertTrue(draft.contains("> linear@app"))
    XCTAssertTrue(draft.contains("> Imported from Linear."))
  }

  private func makeDetail(
    ticket: TicketSummary,
    comments: [TicketComment],
    syncCheckpoints: [TicketSyncCheckpoint],
    conflicts: [TicketSyncConflict]
  ) -> TicketDetailResponse {
    TicketDetailResponse(
      ticket: ticket,
      comments: comments,
      syncCheckpoints: syncCheckpoints,
      conflicts: conflicts,
      events: []
    )
  }

  private func makeTicketSummary(owner: String, source: String, assignee: String?) -> TicketSummary {
    TicketSummary(
      ticketId: "T-00042",
      title: "Investigate sync drift",
      body: "Imported from Linear.",
      status: .inProgress,
      createdAt: "2026-03-05T16:00:00Z",
      updatedAt: "2026-03-05T17:00:00Z",
      dependsOn: ["T-00001"],
      blocks: ["T-00099"],
      owner: owner,
      source: source,
      assignee: assignee,
      tags: ["linear", "review"],
      externalSystem: "linear",
      externalId: "lin_issue_42",
      externalKey: "ENG-42",
      externalUrl: "https://linear.app/hack/issue/ENG-42",
      externalProjectId: "proj-42",
      externalProjectName: "Control Plane",
      externalTeamId: "eng",
      projectId: "local-project",
      projectName: "Hack CLI"
    )
  }
}
