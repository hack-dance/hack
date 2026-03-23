import XCTest

@testable import HackDesktopModels

final class LinearSyncUXModelTests: XCTestCase {
  func testRemoteLinearConnectionWithBrokerSeededLocalAccessRendersConnected() {
    let state = LinearConnectionStateResolver.presentationState(
      profileId: "default",
      localProfilePresent: false,
      localTokenResolved: nil,
      remoteLocalAccessAvailable: true
    )

    XCTAssertEqual(state, .connected)
  }

  func testRemoteLinearConnectionWithoutLocalOrBrokerAccessNeedsAttention() {
    let state = LinearConnectionStateResolver.presentationState(
      profileId: "default",
      localProfilePresent: false,
      localTokenResolved: nil,
      remoteLocalAccessAvailable: false
    )

    XCTAssertEqual(state, .needsAttention)
  }

  func testHackOriginLinkedTicketIsHackAuthoritative() {
    let ticket = makeTicketSummary(
      owner: "hack",
      source: "hack",
      externalSystem: "linear",
      externalId: "lin_issue_1",
      externalKey: "ENG-101"
    )

    XCTAssertEqual(ticket.linearSyncAuthority, .hack)
    XCTAssertTrue(ticket.linearSyncUXState.isLinkedToLinear)
    XCTAssertNil(ticket.linearSyncUXState.reviewHint)
    XCTAssertTrue(ticket.linearSyncUXState.shortGuidance.contains("Hack controls title, body, and status."))
    XCTAssertTrue(ticket.linearSyncUXState.shortGuidance.contains("Hack project placement stays local."))
  }

  func testLinearOriginTicketIsLinearAuthoritative() {
    let ticket = makeTicketSummary(
      owner: "linear",
      source: "linear",
      externalSystem: "linear",
      externalId: "lin_issue_2",
      externalKey: "ENG-102"
    )

    XCTAssertEqual(ticket.linearSyncAuthority, .linear)
    XCTAssertTrue(ticket.linearSyncUXState.isLinkedToLinear)
    XCTAssertNil(ticket.linearSyncUXState.reviewHint)
    XCTAssertTrue(ticket.linearSyncUXState.shortGuidance.contains("Linear controls title, body, and status."))
    XCTAssertTrue(ticket.linearSyncUXState.shortGuidance.contains("Hack project placement stays local."))
  }

  func testLinkedLinearTicketWithMismatchedOwnershipNeedsReviewHint() {
    let ticket = makeTicketSummary(
      owner: "linear",
      source: "hack",
      externalSystem: "linear",
      externalId: "lin_issue_3",
      externalKey: "ENG-103"
    )

    XCTAssertEqual(ticket.linearSyncAuthority, .hack)
    XCTAssertTrue(ticket.linearSyncUXState.isLinkedToLinear)
    XCTAssertEqual(
      ticket.linearSyncUXState.reviewHint,
      "Review assignee, labels, and dependencies before the next sync."
    )
    XCTAssertTrue(ticket.linearSyncUXState.shortGuidance.contains("Comments append only."))
  }

  func testUnlinkedLocalTicketUsesLocalOnlyGuidance() {
    let ticket = makeTicketSummary(
      owner: "hack",
      source: "hack",
      externalSystem: nil,
      externalId: nil,
      externalKey: nil
    )

    XCTAssertEqual(ticket.linearSyncAuthority, .hack)
    XCTAssertFalse(ticket.linearSyncUXState.isLinkedToLinear)
    XCTAssertNil(ticket.linearSyncUXState.reviewHint)
    XCTAssertEqual(
      ticket.linearSyncUXState.shortGuidance,
      "Local only. Connect to Linear to sync this ticket."
    )
  }

  private func makeTicketSummary(
    owner: String,
    source: String,
    externalSystem: String?,
    externalId: String?,
    externalKey: String?,
    assignee: String? = nil
  ) -> TicketSummary {
    TicketSummary(
      ticketId: "T-00001",
      title: "Sync issue",
      body: "Sync issue body",
      status: .open,
      createdAt: "2026-03-05T12:00:00Z",
      updatedAt: "2026-03-05T12:00:00Z",
      dependsOn: [],
      blocks: [],
      owner: owner,
      source: source,
      assignee: assignee,
      tags: ["linear"],
      externalSystem: externalSystem,
      externalId: externalId,
      externalKey: externalKey,
      externalUrl: "https://linear.app/hack/issue/\(externalKey ?? "local")",
      externalProjectId: "proj-1",
      externalProjectName: "Alpha",
      externalTeamId: "team-1",
      projectId: "local-proj-1",
      projectName: "Hack CLI"
    )
  }
}
