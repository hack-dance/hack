import SwiftUI

import HackDesktopModels

struct ProjectInspectorColumn: View {
  @Environment(\.openURL) private var openURL

  let project: ProjectSummary
  let meta: ProjectMeta?
  @Binding var selectedService: String?
  let onAttachSession: (MuxSessionSummary) -> Void
  let onStopSession: (MuxSessionSummary) -> Void
  let onShowLogs: () -> Void
  let onShowShell: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 12) {
        headerRow
        projectCard
      }
      .padding(16)

      Divider()
        .opacity(0.2)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if let selectedService {
            serviceCard(service: selectedService)
            serviceEnvCard(service: selectedService)
            serviceBuildCard(service: selectedService)
          }

          metaSection
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .frame(maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private var headerRow: some View {
    HStack(alignment: .center, spacing: 10) {
      Text("Details")
        .font(.mono(.headline, weight: .semibold))
      if let selectedService {
        BadgePill(label: selectedService, tint: .secondary)
      }
      Spacer()
      if selectedService != nil {
        Button("All") {
          withAnimation(.easeInOut(duration: 0.2)) {
            selectedService = nil
          }
        }
        .font(.mono(.caption, weight: .semibold))
        .buttonStyle(PressableIconButtonStyle())
        .accessibilityLabel("Show all services")
      }
    }
  }

  private var projectCard: some View {
    GlassCard(title: "Project", systemImage: "cube.transparent") {
      VStack(alignment: .leading, spacing: 12) {
        if !projectRows.isEmpty {
          DetailRows(rows: projectRows)
        }

        if let featureSummary = project.featureSummary, !featureSummary.isEmpty {
          Divider()
            .opacity(0.2)
          VStack(alignment: .leading, spacing: 6) {
            Text("Features")
              .instrumentLabel()
            Text(featureSummary)
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }

  private var projectRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    rows.append(DetailRowItem(label: "Status", value: pretty(project.status.rawValue)))
    rows.append(DetailRowItem(label: "Runtime", value: project.runtimeStatusLabel))
    rows.append(DetailRowItem(label: "Kind", value: pretty(project.kind.rawValue)))
    if let devHost = project.devHost, !devHost.isEmpty {
      rows.append(DetailRowItem(label: "Dev host", value: devHost))
    }
    if let repoRoot = project.repoRoot, !repoRoot.isEmpty {
      rows.append(DetailRowItem(label: "Repo root", value: repoRoot))
    }
    if let projectDir = project.projectDir, !projectDir.isEmpty, projectDir != project.repoRoot {
      rows.append(DetailRowItem(label: "Project dir", value: projectDir))
    }
    return rows
  }

  private func serviceCard(service: String) -> some View {
    GlassCard(title: "Service", systemImage: "shippingbox") {
      VStack(alignment: .leading, spacing: 12) {
        if let runtime = runtimeServicesByName[service] {
          let containers = runtime.containers
          let runningCount = containers.filter { $0.state.lowercased() == "running" }.count
          let images = Array(Set(containers.compactMap(\.image))).sorted()
          let ips = Array(Set(containers.compactMap(\.ip))).sorted()
          let mounts = containers.first?.mounts ?? []
          let labels = containers.first?.labels ?? [:]

          let domainHosts = (serviceHostsByName[service] ?? []).sorted()

          HStack(spacing: 8) {
            if let primaryHost = domainHosts.first {
              Button("Open") {
                openServiceHost(primaryHost)
              }
              .font(.mono(.caption, weight: .semibold))
              .buttonStyle(PressableIconButtonStyle())
            }

            Button("Logs") {
              onShowLogs()
            }
            .font(.mono(.caption, weight: .semibold))
            .buttonStyle(PressableIconButtonStyle())

            Button("Shell") {
              onShowShell()
            }
            .font(.mono(.caption, weight: .semibold))
            .buttonStyle(PressableIconButtonStyle())

            Spacer()
          }

          if !domainHosts.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Domains")
                .instrumentLabel()
              ForEach(limited(domainHosts, limit: 6), id: \.self) { host in
                Button {
                  openServiceHost(host)
                } label: {
                  Text(host)
                    .font(.mono(.caption))
                }
                .buttonStyle(.plain)
                .linkHover()
              }
              let hiddenCount = max(0, domainHosts.count - 6)
              if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }

          DetailRows(
            rows: [
              DetailRowItem(label: "Containers", value: "\(containers.count)"),
              DetailRowItem(label: "Running", value: "\(runningCount)"),
              DetailRowItem(label: "Image", value: images.count == 1 ? (images.first ?? "—") : "\(images.count) images"),
              DetailRowItem(label: "IP", value: ips.count == 1 ? (ips.first ?? "—") : (ips.isEmpty ? "—" : "\(ips.count) IPs")),
            ],
            labelWidth: 120
          )

          Divider()
            .opacity(0.2)

          if containers.isEmpty {
            Text("No containers.")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          } else {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(limited(containers, limit: 8), id: \.id) { container in
                VStack(alignment: .leading, spacing: 4) {
                  Text(container.name)
                    .font(.mono(.caption, weight: .semibold))
                  HStack(spacing: 8) {
                    Text(shortId(container.id))
                      .font(.mono(.caption2))
                      .foregroundStyle(.tertiary)
                    if let image = container.image, !image.isEmpty {
                      Text(image)
                        .font(.mono(.caption2))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    }
                  }
                  Text(container.status)
                    .font(.mono(.caption2))
                    .foregroundStyle(.secondary)
                  if !container.ports.isEmpty {
                    Text(container.ports)
                      .font(.mono(.caption2))
                      .foregroundStyle(.tertiary)
                  }
                  if let ip = container.ip, !ip.isEmpty {
                    Text("IP: \(ip)")
                      .font(.mono(.caption2))
                      .foregroundStyle(.tertiary)
                  }
                }
                Divider()
                  .opacity(0.2)
              }

              let hiddenCount = max(0, containers.count - 8)
              if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }

          if !mounts.isEmpty {
            Divider()
              .opacity(0.2)
            VStack(alignment: .leading, spacing: 6) {
              Text("Mounts")
                .instrumentLabel()
              ForEach(limited(mounts, limit: 6).indices, id: \.self) { idx in
                let mount = mounts[idx]
                let source = mount.source ?? "—"
                let destination = mount.destination ?? "—"
                HStack(spacing: 8) {
                  Text(source)
                    .font(.mono(.caption2, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                  Text("→")
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                  Text(destination)
                    .font(.mono(.caption2))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
              }
              let hiddenCount = max(0, mounts.count - 6)
              if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }

          if !labels.isEmpty {
            Divider()
              .opacity(0.2)
            VStack(alignment: .leading, spacing: 6) {
              Text("Labels")
                .instrumentLabel()
              ForEach(limited(labels.keys.sorted(), limit: 10), id: \.self) { key in
                let value = labels[key] ?? ""
                VStack(alignment: .leading, spacing: 2) {
                  Text(key)
                    .font(.mono(.caption2, weight: .semibold))
                    .foregroundStyle(.secondary)
                  Text(value)
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                }
              }
              let hiddenCount = max(0, labels.keys.count - 10)
              if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }
        } else {
          Text("No running containers.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  private func serviceEnvCard(service: String) -> some View {
    GlassCard(title: "Env", systemImage: "key") {
      if let meta {
        let vars = envVars(for: service, meta: meta)
        let missingRequired = vars.filter { $0.required && !$0.hasValue }.map(\.key)

        VStack(alignment: .leading, spacing: 12) {
          DetailRows(
            rows: [
              DetailRowItem(label: "Vars", value: "\(vars.count)"),
              DetailRowItem(label: "Missing", value: "\(missingRequired.count)"),
            ],
            labelWidth: 120
          )

          if !missingRequired.isEmpty {
            Divider()
              .opacity(0.2)
            VStack(alignment: .leading, spacing: 6) {
              Text("Missing required")
                .instrumentLabel()
              ForEach(limited(missingRequired, limit: 10), id: \.self) { key in
                Text(key)
                  .font(.mono(.caption))
                  .foregroundStyle(.orange)
                  .textSelection(.enabled)
              }
              let hiddenCount = max(0, missingRequired.count - 10)
              if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }

          if !vars.isEmpty {
            Divider()
              .opacity(0.2)
            VStack(alignment: .leading, spacing: 8) {
              Text("Variables")
                .instrumentLabel()
              ForEach(limited(vars, limit: 12)) { variable in
                envVarRow(variable)
                Divider()
                  .opacity(0.2)
              }
              let hiddenCount = max(0, vars.count - 12)
              if hiddenCount > 0 {
                Text("+\(hiddenCount) more")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      } else {
        metaLoadingRow
      }
    }
  }

  private func serviceBuildCard(service: String) -> some View {
    GlassCard(title: "Build", systemImage: "hammer") {
      if let meta {
        if let serviceMeta = meta.composeBuild.services.first(where: { $0.service == service }) {
          VStack(alignment: .leading, spacing: 12) {
            let rows = [
              DetailRowItem(label: "Build", value: serviceMeta.build ? "Yes" : "No"),
              DetailRowItem(label: "Context", value: serviceMeta.context ?? "—"),
              DetailRowItem(label: "Dockerfile", value: serviceMeta.dockerfile ?? "—"),
              DetailRowItem(label: "Path", value: serviceMeta.dockerfilePath ?? "—"),
            ]
            DetailRows(rows: rows, labelWidth: 120)
            if serviceMeta.dockerfilePath != nil {
              let exists = serviceMeta.dockerfileExists == true
              StatusPill(text: exists ? "Dockerfile found" : "Dockerfile missing", tone: exists ? .good : .warn)
            }
          }
        } else {
          Text("No build metadata for this service.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        }
      } else {
        metaLoadingRow
      }
    }
  }

  @ViewBuilder
  private var metaSection: some View {
    if let meta {
      gitCard(meta: meta)
      sessionsCard(meta: meta)
      envCard(meta: meta)
      composeBuildCard(meta: meta)
      hackBranchesCard(meta: meta)
    } else {
      GlassCard(title: "Meta", systemImage: "info.circle") {
        metaLoadingRow
      }
    }
  }

  private func gitCard(meta: ProjectMeta) -> some View {
    GlassCard(title: "Git", systemImage: "arrow.triangle.branch") {
      VStack(alignment: .leading, spacing: 12) {
        DetailRows(rows: gitRows(meta: meta), labelWidth: 120)
        if let worktrees = meta.git.worktrees, !worktrees.isEmpty {
          Divider()
            .opacity(0.2)
          VStack(alignment: .leading, spacing: 6) {
            Text("Worktrees")
              .instrumentLabel()
            ForEach(limited(worktrees, limit: 8), id: \.path) { worktree in
              VStack(alignment: .leading, spacing: 2) {
                Text(worktree.path)
                  .font(.mono(.caption, weight: .semibold))
                  .textSelection(.enabled)
                if let branch = worktree.branch {
                  Text(branch)
                    .font(.mono(.caption2))
                    .foregroundStyle(.secondary)
                } else if worktree.detached, let head = worktree.head {
                  Text("Detached @ \(head)")
                    .font(.mono(.caption2))
                    .foregroundStyle(.secondary)
                }
              }
              Divider()
                .opacity(0.2)
            }
            let hiddenCount = max(0, worktrees.count - 8)
            if hiddenCount > 0 {
              Text("+\(hiddenCount) more")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private func gitRows(meta: ProjectMeta) -> [DetailRowItem] {
    var rows: [DetailRowItem] = []
    rows.append(DetailRowItem(label: "Repo", value: meta.git.isRepo ? "Yes" : "No"))
    if let branch = meta.git.branch, !branch.isEmpty {
      rows.append(DetailRowItem(label: "Branch", value: branch))
    }
    if let head = meta.git.head, !head.isEmpty {
      rows.append(DetailRowItem(label: "HEAD", value: head))
    }
    if let detached = meta.git.detached {
      rows.append(DetailRowItem(label: "Detached", value: detached ? "Yes" : "No"))
    }
    if let dirty = meta.git.dirty {
      rows.append(DetailRowItem(label: "Dirty", value: dirty ? "Yes" : "No"))
    }
    if let localCount = meta.git.localBranchCount {
      rows.append(DetailRowItem(label: "Branches", value: "\(localCount)"))
    }
    if let worktrees = meta.git.worktrees {
      rows.append(DetailRowItem(label: "Worktrees", value: "\(worktrees.count)"))
    }
    if let error = meta.git.error, !error.isEmpty {
      rows.append(DetailRowItem(label: "Error", value: error))
    }
    return rows
  }

  private func sessionsCard(meta: ProjectMeta) -> some View {
    GlassCard(title: "Sessions", systemImage: "rectangle.split.3x1") {
      VStack(alignment: .leading, spacing: 12) {
        DetailRows(
          rows: [
            DetailRowItem(label: "Count", value: "\(meta.sessions.sessions.count)"),
          ],
          labelWidth: 120
        )
        if meta.sessions.sessions.isEmpty {
          Text("No sessions detected.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        } else {
          Divider()
            .opacity(0.2)
          VStack(alignment: .leading, spacing: 8) {
            ForEach(limited(meta.sessions.sessions, limit: 10)) { session in
              sessionRow(session)
              Divider()
                .opacity(0.2)
            }
            let hiddenCount = max(0, meta.sessions.sessions.count - 10)
            if hiddenCount > 0 {
              Text("+\(hiddenCount) more")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private func sessionRow(_ session: MuxSessionSummary) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(session.name)
          .font(.mono(.caption, weight: .semibold))
          .textSelection(.enabled)
        if let path = session.path {
          Text(path)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
        }
      }
      Spacer()
      BadgePill(label: session.backend, tint: .secondary)
      if let windows = session.windows {
        BadgePill(label: "\(windows)w", tint: .secondary)
      }
      if session.attached == true {
        StatusPill(text: "Attached", tone: .good)
      }
      HStack(spacing: 6) {
        Button("Attach") {
          onAttachSession(session)
        }
        .font(.mono(.caption, weight: .semibold))
        .buttonStyle(PressableIconButtonStyle())
        .accessibilityLabel("Attach to session \(session.name)")

        Button("Stop") {
          onStopSession(session)
        }
        .font(.mono(.caption, weight: .semibold))
        .buttonStyle(PressableIconButtonStyle())
        .accessibilityLabel("Stop session \(session.name)")
      }
    }
  }

  private func envCard(meta: ProjectMeta) -> some View {
    GlassCard(title: "Env", systemImage: "key") {
      VStack(alignment: .leading, spacing: 12) {
        DetailRows(
          rows: [
            DetailRowItem(label: "Contract", value: meta.env.contractExists ? "Found" : "Missing"),
            DetailRowItem(label: "Vars", value: "\(meta.env.vars.count)"),
            DetailRowItem(label: "Missing", value: "\(meta.env.missingRequired.count)"),
          ],
          labelWidth: 120
        )

        if let parseError = meta.env.contractParseError, !parseError.isEmpty {
          Divider()
            .opacity(0.2)
          Text(parseError)
            .font(.mono(.caption))
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }

        if !meta.env.missingRequired.isEmpty {
          Divider()
            .opacity(0.2)
          VStack(alignment: .leading, spacing: 6) {
            Text("Missing required")
              .instrumentLabel()
            ForEach(limited(meta.env.missingRequired, limit: 10), id: \.self) { key in
              Text(key)
                .font(.mono(.caption))
                .foregroundStyle(.orange)
                .textSelection(.enabled)
            }
            let hiddenCount = max(0, meta.env.missingRequired.count - 10)
            if hiddenCount > 0 {
              Text("+\(hiddenCount) more")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          }
        }

        Divider()
          .opacity(0.2)
        VStack(alignment: .leading, spacing: 8) {
          Text("Variables")
            .instrumentLabel()
          ForEach(limited(meta.env.vars, limit: 12)) { variable in
            envVarRow(variable)
            Divider()
              .opacity(0.2)
          }
          let hiddenCount = max(0, meta.env.vars.count - 12)
          if hiddenCount > 0 {
            Text("+\(hiddenCount) more")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
        }
      }
    }
  }

  private func envVarRow(_ variable: EnvVarMeta) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(variable.key)
          .font(.mono(.caption, weight: .semibold))
          .textSelection(.enabled)
        if let services = variable.services, !services.isEmpty {
          Text(services.sorted().joined(separator: ", "))
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        } else if let description = variable.description, !description.isEmpty {
          Text(description)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
      Spacer()

      if variable.required {
        BadgePill(label: "Required", tint: .orange)
      }

      BadgePill(label: variable.source == .keychain ? "Keychain" : "Env", tint: .secondary)

      let tone: StatusTone = variable.hasValue ? .good : (variable.required ? .warn : .neutral)
      StatusPill(text: variable.hasValue ? "Set" : "Missing", tone: tone)
    }
  }

  private func composeBuildCard(meta: ProjectMeta) -> some View {
    GlassCard(title: "Compose build", systemImage: "hammer") {
      let services = meta.composeBuild.services.sorted { $0.service < $1.service }
      VStack(alignment: .leading, spacing: 12) {
        DetailRows(
          rows: [
            DetailRowItem(label: "Services", value: "\(services.count)"),
          ],
          labelWidth: 120
        )
        if services.isEmpty {
          Text("No build config detected.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        } else {
          Divider()
            .opacity(0.2)
          VStack(alignment: .leading, spacing: 8) {
            ForEach(limited(services, limit: 10)) { service in
              composeBuildRow(service)
              Divider()
                .opacity(0.2)
            }
            let hiddenCount = max(0, services.count - 10)
            if hiddenCount > 0 {
              Text("+\(hiddenCount) more")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private func composeBuildRow(_ service: ComposeBuildServiceMeta) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(service.service)
          .font(.mono(.caption, weight: .semibold))
        Spacer()
        StatusPill(text: service.build ? "Build" : "No build", tone: service.build ? .good : .neutral)
      }
      if let dockerfilePath = service.dockerfilePath, !dockerfilePath.isEmpty {
        Text(dockerfilePath)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
      } else if let context = service.context, !context.isEmpty {
        Text(context)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
      }
    }
  }

  private func hackBranchesCard(meta: ProjectMeta) -> some View {
    GlassCard(title: "Hack branches", systemImage: "point.3.filled.connected.trianglepath.dotted") {
      let branches = meta.hackBranches.branches
      VStack(alignment: .leading, spacing: 12) {
        DetailRows(
          rows: [
            DetailRowItem(label: "File", value: meta.hackBranches.path),
            DetailRowItem(label: "Branches", value: "\(branches.count)"),
          ],
          labelWidth: 120
        )

        if let parseError = meta.hackBranches.parseError, !parseError.isEmpty {
          Divider()
            .opacity(0.2)
          Text(parseError)
            .font(.mono(.caption))
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }

        if branches.isEmpty {
          Text("No branches detected.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        } else {
          Divider()
            .opacity(0.2)
          VStack(alignment: .leading, spacing: 8) {
            ForEach(limited(branches, limit: 10)) { branch in
              hackBranchRow(branch)
              Divider()
                .opacity(0.2)
            }
            let hiddenCount = max(0, branches.count - 10)
            if hiddenCount > 0 {
              Text("+\(hiddenCount) more")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private func hackBranchRow(_ branch: HackBranchEntry) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(branch.name)
          .font(.mono(.caption, weight: .semibold))
        Spacer()
        BadgePill(label: branch.slug, tint: .secondary)
      }
      if let note = branch.note, !note.isEmpty {
        Text(note)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let lastUsedAt = branch.lastUsedAt {
        Text("Last used: \(lastUsedAt)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      } else if let createdAt = branch.createdAt {
        Text("Created: \(createdAt)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      }
    }
  }

  private var metaLoadingRow: some View {
    HStack(spacing: 10) {
      ProgressView()
        .controlSize(.small)
      Text("Fetching meta…")
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var runtimeServicesByName: [String: RuntimeService] {
    guard let runtime = project.runtime else { return [:] }
    return Dictionary(
      runtime.services.map { ($0.service, $0) },
      uniquingKeysWith: { first, _ in first }
    )
  }

  private var serviceHostsByName: [String: [String]] {
    project.serviceHosts ?? [:]
  }

  private func serviceHostLabel(for service: String) -> String? {
    if let hosts = serviceHostsByName[service], let first = hosts.first {
      if hosts.count > 1 {
        return "\(first) +\(hosts.count - 1)"
      }
      return first
    }
    guard let host = project.devHost, !host.isEmpty else { return nil }
    return "\(service).\(host)"
  }

  private func envVars(for service: String, meta: ProjectMeta) -> [EnvVarMeta] {
    meta.env.vars
      .filter { $0.services == nil || $0.services?.contains(service) == true }
      .sorted { $0.key < $1.key }
  }

  private func pretty(_ value: String) -> String {
    value.replacingOccurrences(of: "_", with: " ").capitalized
  }

  private func openServiceHost(_ host: String) {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let urlString = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    if let url = URL(string: urlString) {
      openURL(url)
    }
  }

  private func limited<Element>(_ items: [Element], limit: Int) -> [Element] {
    if items.count <= limit { return items }
    return Array(items.prefix(limit))
  }

  private func shortId(_ id: String) -> String {
    let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 12 else { return trimmed }
    return String(trimmed.prefix(12))
  }
}
