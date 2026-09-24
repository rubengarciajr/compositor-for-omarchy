import SwiftUI
import UniformTypeIdentifiers
import AppKit
import Combine

struct ProjectWorkspaceView: View {
    let applicationDelegate: CompositorApplicationDelegate
    private var workspace: ProjectWorkspace { applicationDelegate.workspace }
    var body: some View {
        ContentView(session: workspace.current.session, applicationDelegate: applicationDelegate)
            .id(workspace.current.id)
            .disabled(workspace.isManaging)
            .psdConversionSheet(workspace.current.session)
            .rawDevelopSheet(workspace.current.session)
            .background {
                ProjectWindowBridge(controller: workspace.current.controller).frame(width: 0, height: 0)
            }
    }
}

struct ProjectTabStrip: View {
    let workspace: ProjectWorkspace
    @State private var dragging = false
    /// Scrolled away from the first tab, so the left edge fades too.
    @State private var scrolledFromStart = false
    @State private var dragChangeCount = NSPasteboard(name: .drag).changeCount
    private let dragTimer = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()
    var body: some View {
        ProjectTabScroller(workspace: workspace, dragging: dragging,
                           onScrollFromStart: { scrolledFromStart = $0 })
        .frame(height: 34, alignment: .center)
        // Tabs fade out where they scroll under an edge instead of being cut off — the right edge always, the left
        // once scrolled away from the first tab. A mask rather than a painted gradient, so whatever the toolbar shows
        // behind them shows through.
        .mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: scrolledFromStart ? 28 : 0)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 28)
            }
            .animation(.easeOut(duration: 0.15), value: scrolledFromStart)
        }
        .accessibilityLabel("Project tabs")
        .onReceive(dragTimer) { _ in
            // External drags don't deliver mouse-down to our window. Track the
            // drag pasteboard's new session, and clear on release/cancel.
            let pasteboard = NSPasteboard(name: .drag)
            if NSEvent.pressedMouseButtons == 0 {
                dragging = false
                dragChangeCount = pasteboard.changeCount
            } else if pasteboard.changeCount != dragChangeCount {
                dragging = pasteboard.availableType(from: [.fileURL, .png, .tiff, NSPasteboard.PasteboardType(ProjectWorkspace.layerType)]) != nil
            }
        }
    }
}

private func projectTabLabelWidth(_ tab: ProjectTab, active: Bool) -> CGFloat {
    let font = NSFont.systemFont(ofSize: 12, weight: active ? .semibold : .medium)
    let titleWidth = (tab.title as NSString).size(withAttributes: [.font: font]).width
    let dotWidth: CGFloat = tab.session.isModified ? 10 : 0 // 5 px dot and 5 px gap
    return min(155, max(35, ceil(titleWidth) + dotWidth))
}

private func projectTabPillWidth(_ tab: ProjectTab, active: Bool) -> CGFloat {
    // 11 px leading, 8 px trailing, 16 px close button, 5 px after close.
    projectTabLabelWidth(tab, active: active) + 40
}

/// Lay out tabs from x = 0 so a title or unsaved dot only moves tabs after it.
/// The document view has no scroller, so its viewport never gains a scrollbar inset.
private struct ProjectTabScroller: NSViewRepresentable {
    let workspace: ProjectWorkspace
    let dragging: Bool
    let onScrollFromStart: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> TabScrollView {
        let view = TabScrollView()
        view.contentView.postsBoundsChangedNotifications = true
        context.coordinator.observer = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification, object: view.contentView, queue: .main
        ) { [weak view, weak coordinator = context.coordinator] _ in
            guard let view, let coordinator else { return }
            let scrolled = view.contentView.bounds.minX > 1
            DispatchQueue.main.async { coordinator.onScrollFromStart?(scrolled) }
        }
        return view
    }

    func updateNSView(_ view: TabScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onScrollFromStart = onScrollFromStart
        let oldOffset = view.contentView.bounds.minX
        let currentIDs = Set(workspace.tabs.map(\.id))
        for id in coordinator.tabHosts.keys.filter({ !currentIDs.contains($0) }) {
            coordinator.tabHosts[id]?.removeFromSuperview()
            coordinator.tabHosts.removeValue(forKey: id)
        }

        var x: CGFloat = 0
        for tab in workspace.tabs {
            let host: NSHostingView<ProjectTabButton>
            if let existing = coordinator.tabHosts[tab.id] {
                host = existing
                host.rootView = ProjectTabButton(workspace: workspace, tab: tab)
            } else {
                host = NSHostingView(rootView: ProjectTabButton(workspace: workspace, tab: tab))
                coordinator.tabHosts[tab.id] = host
                view.tabsDocument.addSubview(host)
            }
            let width = projectTabPillWidth(tab, active: workspace.selectedID == tab.id)
            host.frame = NSRect(x: x, y: 3, width: width, height: 28)
            x += width + 6
        }

        if dragging {
            let host: NSHostingView<NewTabDropSlot>
            if let existing = coordinator.dropHost {
                host = existing
                host.rootView = NewTabDropSlot(workspace: workspace)
            } else {
                host = NSHostingView(rootView: NewTabDropSlot(workspace: workspace))
                coordinator.dropHost = host
                view.tabsDocument.addSubview(host)
            }
            host.invalidateIntrinsicContentSize()
            let width = ceil(host.fittingSize.width)
            host.frame = NSRect(x: x, y: 3, width: width, height: 28)
            x += width + 6
        } else {
            coordinator.dropHost?.removeFromSuperview()
            coordinator.dropHost = nil
        }

        view.tabsDocument.setFrameSize(NSSize(width: max(0, x - 6), height: 34))
        let maxOffset = max(0, view.tabsDocument.frame.width - view.contentView.bounds.width)
        view.horizontalScrollElasticity = maxOffset > 1 ? .allowed : .none
        view.contentView.scroll(to: NSPoint(x: min(oldOffset, maxOffset), y: 0))
        view.reflectScrolledClipView(view.contentView)

        if dragging != coordinator.wasDragging || workspace.selectedID != coordinator.lastSelectedID {
            coordinator.wasDragging = dragging
            coordinator.lastSelectedID = workspace.selectedID
            DispatchQueue.main.async { [weak view] in
                guard let view else { return }
                if dragging, let drop = coordinator.dropHost {
                    view.reveal(drop.frame, trailing: true)
                } else if let selected = coordinator.tabHosts[workspace.selectedID] {
                    view.reveal(selected.frame, trailing: false)
                }
            }
        }
    }

    final class Coordinator {
        var tabHosts: [UUID: NSHostingView<ProjectTabButton>] = [:]
        var dropHost: NSHostingView<NewTabDropSlot>?
        var lastSelectedID: UUID?
        var wasDragging = false
        var onScrollFromStart: ((Bool) -> Void)?
        var observer: NSObjectProtocol?
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }

    final class TabScrollView: NSScrollView {
        let tabsDocument = FlippedTabDocument()

        init() {
            super.init(frame: .zero)
            drawsBackground = false
            borderType = .noBorder
            hasVerticalScroller = false
            hasHorizontalScroller = false
            verticalScrollElasticity = .none
            horizontalScrollElasticity = .none
            documentView = tabsDocument
        }

        required init?(coder: NSCoder) { nil }

        func reveal(_ rect: NSRect, trailing: Bool) {
            let viewport = contentView.bounds
            let x = trailing ? rect.maxX - viewport.width :
                rect.minX < viewport.minX ? rect.minX :
                rect.maxX > viewport.maxX ? rect.maxX - viewport.width : viewport.minX
            let maxOffset = max(0, tabsDocument.frame.width - viewport.width)
            contentView.scroll(to: NSPoint(x: min(max(0, x), maxOffset), y: 0))
            reflectScrolledClipView(contentView)
        }
    }

    final class FlippedTabDocument: NSView {
        override var isFlipped: Bool { true }
    }
}

private struct NewTabDropSlot: View {
    let workspace: ProjectWorkspace
    @State private var targeted = false
    var body: some View {
        Label("New", systemImage: "plus")
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 14).frame(height: 28)
            .background(targeted ? Color.accentColor.opacity(0.3) : Color.white.opacity(0.04), in: Capsule())
            .overlay(Capsule().strokeBorder(targeted ? Color.accentColor : Color.secondary,
                style: StrokeStyle(lineWidth: targeted ? 2 : 1, dash: targeted ? [] : [4, 3])))
            .contentShape(Capsule())
            .help("Drop to open in a new canvas")
            .accessibilityLabel("Drop into new canvas")
            .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier, ProjectWorkspace.layerType], delegate:
                ProjectTabDropDelegate(workspace: workspace, destination: nil, targeted: $targeted))
    }
}

private struct ProjectTabButton: View {
    let workspace: ProjectWorkspace
    let tab: ProjectTab
    @State private var targeted = false
    private var active: Bool { workspace.selectedID == tab.id }
    var body: some View {
        HStack(spacing: 0) {
            Button { workspace.select(tab.id) } label: {
                HStack(spacing: 5) {
                    if tab.session.isModified {
                        Circle().frame(width: 5, height: 5).accessibilityLabel("Unsaved changes")
                    }
                    Text(tab.title).font(.system(size: 12, weight: active ? .semibold : .medium)).lineLimit(1)
                }
                .frame(width: projectTabLabelWidth(tab, active: active), alignment: .leading)
                .padding(.leading, 11).padding(.trailing, 8)
                .frame(height: 28)
                .contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(!workspace.canSwitch && !active)
            Button { Task { await workspace.close(tab.id) } } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                    .frame(width: 16, height: 28)
                    .padding(.trailing, 5)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).help("Close \(tab.title)").disabled(!workspace.canSwitch)
                .accessibilityLabel("Close \(tab.title)")
        }
        .frame(width: projectTabPillWidth(tab, active: active), height: 28, alignment: .leading)
        .background(targeted ? Color.accentColor.opacity(0.3) : Color.white.opacity(active ? 0.12 : 0.035), in: Capsule())
        .overlay(Capsule().strokeBorder(targeted ? Color.accentColor : Color.white.opacity(active ? 0.22 : 0.08), lineWidth: targeted ? 2 : 1))
        .help(targeted ? "Add to \(tab.title)" : tab.title)
        .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier, ProjectWorkspace.layerType], delegate:
            ProjectTabDropDelegate(workspace: workspace, destination: tab.id, targeted: $targeted))
    }
}

struct NewProjectDropTarget: ViewModifier {
    let workspace: ProjectWorkspace?
    @State private var targeted = false
    func body(content: Content) -> some View {
        content
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(targeted ? Color.accentColor : .clear, lineWidth: 2))
            .help(targeted ? "Open in a new project tab" : "New canvas (⌘N) · Drop images here for new tabs")
            .onDrop(of: [UTType.fileURL.identifier, UTType.image.identifier, ProjectWorkspace.layerType], delegate:
                ProjectTabDropDelegate(workspace: workspace, destination: nil, targeted: $targeted))
    }
}

extension ProjectWorkspace {
    /// The tab a layer drag started from: drops carry only the layer's id, and the drag pasteboard can be read
    /// while the drag is still in the air, before any drop.
    var draggedLayerSource: UUID? {
        guard let value = NSPasteboard(name: .drag).string(forType: NSPasteboard.PasteboardType(Self.layerType)),
              let id = UUID(uuidString: value.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return tabs.first { $0.session.document?.layers.contains { $0.id == id } == true }?.id
    }
    /// Dragging a layer onto the canvas or tab it already lives in would do nothing, so that isn't a drop target.
    /// Other tabs, a new tab, and every file drag still are.
    func canReceiveDrag(into destination: UUID?) -> Bool {
        guard let destination, let source = draggedLayerSource else { return true }
        return source != destination
    }
}

private struct ProjectTabDropDelegate: DropDelegate {
    let workspace: ProjectWorkspace?
    let destination: UUID?
    @Binding var targeted: Bool
    func validateDrop(info: DropInfo) -> Bool {
        // Option-dragging a layer duplicates it within the Layers panel, so it is not a drag to another project.
        if NSEvent.modifierFlags.contains(.option), info.hasItemsConforming(to: [ProjectWorkspace.layerType]) { return false }
        return workspace?.canSwitch == true && workspace?.canReceiveDrag(into: destination) == true
            && info.hasItemsConforming(to: [ProjectWorkspace.layerType, UTType.fileURL.identifier, UTType.image.identifier])
    }
    func dropEntered(info: DropInfo) { targeted = validateDrop(info: info) }
    func dropExited(info: DropInfo) { targeted = false }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: validateDrop(info: info) ? .copy : .forbidden)
    }
    func performDrop(info: DropInfo) -> Bool {
        targeted = false
        guard let workspace, validateDrop(info: info) else { return false }
        let providers = info.itemProviders(for: [ProjectWorkspace.layerType, UTType.fileURL.identifier, UTType.image.identifier])
        Task { await workspace.receiveProviders(providers, into: destination) }
        return true
    }
}
