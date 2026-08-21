import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  RefreshCw,
  Search
} from "lucide-react";
import type { TreeEntry, WorkspaceInfo } from "../types";
import { isImagePath, parentPaths } from "../utils";

type SidebarProps = {
  workspace: WorkspaceInfo | null;
  entries: TreeEntry[];
  activePath: string | null;
  loading: boolean;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onCloseWorkspace: () => void;
  onSelectFile: (path: string) => void;
  onCreate: (kind: "file" | "directory", parent: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onExpand: (path: string) => void;
  onRefresh: () => void;
  onSearch: () => void;
  loadingDirectories: Set<string>;
};

export function Sidebar({
  workspace,
  entries,
  activePath,
  loading,
  onOpenFolder,
  onOpenFile,
  onCloseWorkspace,
  onSelectFile,
  onCreate,
  onRename,
  onDelete,
  onExpand,
  onRefresh,
  onSearch,
  loadingDirectories
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ path: string; kind: TreeEntry["kind"]; x: number; y: number } | null>(null);

  useEffect(() => setExpanded(new Set()), [workspace?.root, workspace?.initial_file]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => parentPaths(entry.path).every((parent) => expanded.has(parent))),
    [expanded, entries]
  );

  function toggleDirectory(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        onExpand(path);
      }
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <header className="sidebarHeader">
        <span>EXPLORER</span>
        <div className="sidebarActions">
          {workspace?.kind === "folder" ? <button type="button" onClick={() => onCreate("file", "")} title="New file"><FilePlus2 size={15} /></button> : null}
          {workspace?.kind === "folder" ? <button type="button" onClick={() => onCreate("directory", "")} title="New folder"><FolderPlus size={15} /></button> : null}
          {workspace ? <button type="button" onClick={onSearch} title="Search workspace (Ctrl+Shift+F)"><Search size={15} /></button> : null}
          {workspace ? <button type="button" onClick={onRefresh} title="Refresh"><RefreshCw size={14} /></button> : null}
          <button type="button" onClick={onOpenFolder} title="Open folder"><FolderPlus size={15} /></button>
          <button type="button" onClick={onOpenFile} title="Open file"><FileCode2 size={15} /></button>
          {workspace ? <button type="button" onClick={onCloseWorkspace} title="Close workspace"><PanelLeftClose size={15} /></button> : null}
        </div>
      </header>
      {workspace ? (
        <>
          <div className="workspaceTitle" title={workspace.root}>
            <FolderOpen size={15} />
            <strong>{workspace.name}</strong>
          </div>
          <div className="treeScroll">
            {loading ? <div className="sidebarMessage"><RefreshCw className="spin" size={15} /> Loading…</div> : null}
            {!loading && visibleEntries.length === 0 ? <div className="sidebarMessage">This folder is empty.</div> : null}
            {visibleEntries.map((entry) => {
              const isDirectory = entry.kind === "directory";
              const isExpanded = expanded.has(entry.path);
              const isLoading = loadingDirectories.has(entry.path);
              return (
                <button
                  type="button"
                  key={entry.path}
                  className={`treeRow${activePath === entry.path ? " active" : ""}`}
                  style={{ paddingLeft: `${8 + entry.depth * 15}px` }}
                  title={entry.path}
                  onClick={() => isDirectory ? toggleDirectory(entry.path) : onSelectFile(entry.path)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ path: entry.path, kind: entry.kind, x: event.clientX, y: event.clientY });
                  }}
                >
                  <span className="treeChevron">
                    {isDirectory ? isLoading ? <RefreshCw className="spin" size={13} />
                      : isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                  </span>
                  {isDirectory ? <Folder size={15} /> : fileIcon(entry.path)}
                  <span>{entry.name}</span>
                </button>
              );
            })}
          </div>
          {menu ? (
            <div className="treeContextMenu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
              {menu.kind === "directory" ? <button type="button" onClick={() => { onCreate("file", menu.path); setMenu(null); }}>New file inside</button> : null}
              {menu.kind === "directory" ? <button type="button" onClick={() => { onCreate("directory", menu.path); setMenu(null); }}>New folder inside</button> : null}
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(menu.path); setMenu(null); }}>Copy relative path</button>
              <button type="button" onClick={() => { onRename(menu.path); setMenu(null); }}>Rename…</button>
              <button type="button" className="danger" onClick={() => { onDelete(menu.path); setMenu(null); }}>Delete…</button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="emptySidebar">
          <p>No folder open</p>
          <button type="button" onClick={onOpenFolder}>Open Folder</button>
          <button type="button" onClick={onOpenFile}>Open File</button>
        </div>
      )}
    </aside>
  );
}

function fileIcon(path: string) {
  if (isImagePath(path)) return <FileImage className="imageFileIcon" size={15} />;
  if (/\.(rs|ts|tsx|js|jsx|py|go|c|cpp|h|java)$/i.test(path)) return <FileCode2 className="codeFileIcon" size={15} />;
  return <File size={15} />;
}
