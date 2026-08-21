import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createEntry,
  deleteEntry,
  getInitialWorkspace,
  getTree,
  getWorkspaceFiles,
  openWorkspace,
  readFile,
  renameEntry,
  searchWorkspace,
  watchWorkspace,
  writeFile
} from "./api";
import { EditorArea } from "./components/EditorArea";
import { OpenWorkspaceDialog } from "./components/OpenWorkspaceDialog";
import { Sidebar } from "./components/Sidebar";
import { TerminalLauncher } from "./components/TerminalLauncher";
import { WorkspacePalette } from "./components/WorkspacePalette";
import type { FileChange, OpenDocument, SearchMatch, TreeEntry, WorkspaceInfo } from "./types";
import { isImagePath } from "./utils";
import "./styles.css";

type OpenMode = "folder" | "file";
type PaletteMode = "files" | "search";
type RevealLocation = { path: string; line: number; column: number; token: number };

const recentStorageKey = "oxidize.recentPaths";
const draftsStorageKey = "oxidize.drafts.v1";
const sessionsStorageKey = "oxidize.sessions.v1";

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const workspaceRef = useRef<WorkspaceInfo | null>(null);
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [quickOpenEntries, setQuickOpenEntries] = useState<TreeEntry[]>([]);
  const [loadingQuickOpen, setLoadingQuickOpen] = useState(false);
  const loadedDirectories = useRef<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set());
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const documentsRef = useRef<OpenDocument[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [openMode, setOpenMode] = useState<OpenMode | null>(null);
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const searchRequest = useRef(0);
  const [revealLocation, setRevealLocation] = useState<RevealLocation | null>(null);
  const [recentPaths, setRecentPaths] = useState<string[]>(readRecentPaths);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeDocument = useMemo(
    () => documents.find((document) => document.path === activePath) ?? null,
    [activePath, documents]
  );
  const hasDirtyDocuments = documents.some((document) => document.content !== document.savedContent);

  workspaceRef.current = workspace;
  useEffect(() => { documentsRef.current = documents; }, [documents]);

  useEffect(() => {
    async function loadInitialWorkspace() {
      try {
        const initial = await getInitialWorkspace();
        if (initial) await activateWorkspace(initial);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setLoadingWorkspace(false);
      }
    }
    void loadInitialWorkspace();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setOpenMode("file");
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o" && !event.shiftKey) {
        event.preventDefault();
        setOpenMode("folder");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p" && workspace) {
        event.preventDefault();
        void showFilePalette();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f" && workspace) {
        event.preventDefault();
        setPaletteMode("search");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeDocument, workspace]);

  useEffect(() => {
    if (!hasDirtyDocuments) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDirtyDocuments]);

  useEffect(() => {
    if (!workspace || loadingWorkspace) return;
    saveSession(workspace, documents.map((document) => document.path), activePath);
    saveDrafts(workspace, documents);
  }, [activePath, documents, loadingWorkspace, workspace]);

  useEffect(() => {
    if (!workspace) return;
    return watchWorkspace(workspace, (changes) => void handleFileChanges(workspace, changes));
  }, [workspace?.root, workspace?.initial_file]);

  async function activateWorkspace(nextWorkspace: WorkspaceInfo) {
    setError(null);
    setStatus("Loading workspace…");
    setWorkspace(nextWorkspace);
    setPaletteMode(null);
    setSearchResults([]);
    searchRequest.current += 1;
    setTreeEntries([]);
    setQuickOpenEntries([]);
    loadedDirectories.current = new Set();
    setLoadingDirectories(new Set());
    setDocuments([]);
    setActivePath(null);
    try {
      const entries = await getTree(nextWorkspace);
      setTreeEntries(entries);
      loadedDirectories.current = new Set([""]);
      rememberPath(nextWorkspace.initial_file ? `${nextWorkspace.root}/${nextWorkspace.initial_file}` : nextWorkspace.root);

      const session = readSession(nextWorkspace);
      const requested = nextWorkspace.initial_file
        ? [nextWorkspace.initial_file]
        : (session?.paths ?? []).slice(0, 20);
      const loaded = (await Promise.all(requested.map(async (path) => {
        try { return await loadDocument(nextWorkspace, path); } catch { return null; }
      }))).filter((document): document is OpenDocument => document != null);
      setDocuments(loaded);
      setActivePath(
        loaded.some((document) => document.path === session?.activePath)
          ? session!.activePath
          : loaded[0]?.path ?? null
      );
      setStatus(null);
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    }
  }

  async function handleOpen(path: string) {
    setLoadingWorkspace(true);
    setError(null);
    try {
      const nextWorkspace = await openWorkspace(path);
      await activateWorkspace(nextWorkspace);
      setOpenMode(null);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally {
      setLoadingWorkspace(false);
    }
  }

  async function refreshTree(target = workspace) {
    if (!target) return;
    try {
      const directories = [...loadedDirectories.current].sort((left, right) => pathDepth(left) - pathDepth(right));
      const results = await Promise.allSettled(directories.map(async (path) => ({ path, entries: await getTree(target, path) })));
      if (!workspaceRef.current || workspaceKey(workspaceRef.current) !== workspaceKey(target)) return;
      let entries: TreeEntry[] = [];
      const loaded = new Set<string>();
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        entries = replaceDirectoryChildren(entries, result.value.path, result.value.entries);
        loaded.add(result.value.path);
      }
      if (!loaded.has("")) throw new Error("Cannot refresh workspace root");
      loadedDirectories.current = loaded;
      setTreeEntries(entries);
    }
    catch (caught) { setError(errorMessage(caught)); }
  }

  async function loadTreeDirectory(target: WorkspaceInfo, path: string) {
    if (loadedDirectories.current.has(path)) return;
    setLoadingDirectories((current) => new Set(current).add(path));
    try {
      const entries = await getTree(target, path);
      if (!workspaceRef.current || workspaceKey(workspaceRef.current) !== workspaceKey(target)) return;
      loadedDirectories.current.add(path);
      setTreeEntries((current) => replaceDirectoryChildren(current, path, entries));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  }

  async function refreshDirectory(target: WorkspaceInfo, path: string) {
    if (!loadedDirectories.current.has(path)) return;
    try {
      const entries = await getTree(target, path);
      if (workspaceRef.current && workspaceKey(workspaceRef.current) === workspaceKey(target)) {
        setTreeEntries((current) => replaceDirectoryChildren(current, path, entries));
      }
    } catch {
      loadedDirectories.current.delete(path);
    }
  }

  async function handleFileChanges(target: WorkspaceInfo, changes: FileChange[]) {
    if (changes.length === 0) return;
    if (!workspaceRef.current || workspaceKey(workspaceRef.current) !== workspaceKey(target)) return;
    if (changes.some((change) => change.kind === "resync")) {
      await refreshTree(target);
    } else {
      const parents = new Set(changes
        .filter((change) => change.kind === "created" || change.kind === "removed")
        .map((change) => parentPath(change.path)));
      await Promise.all([...parents].map((path) => refreshDirectory(target, path)));
    }
    for (const change of changes) {
      if (change.kind === "resync") continue;
      if (change.kind === "removed") {
        const removed = (path: string) => path === change.path || path.startsWith(`${change.path}/`);
        if (documentsRef.current.some((candidate) => removed(candidate.path))) {
          setDocuments((current) => current.map((candidate) => removed(candidate.path)
            ? { ...candidate, error: "This file was removed from disk.", externalChanged: true }
            : candidate));
        }
        continue;
      }
      const document = documentsRef.current.find((candidate) => candidate.path === change.path);
      if (!document) continue;
      if (document.kind === "image") {
        setDocuments((current) => current.map((candidate) => candidate.path === change.path
          ? { ...candidate, revision: candidate.revision + 1 }
          : candidate));
        continue;
      }
      if (document.content !== document.savedContent) {
        setDocuments((current) => current.map((candidate) => candidate.path === change.path
          ? { ...candidate, externalChanged: true }
          : candidate));
        continue;
      }
      try {
        const file = await readFile(target, change.path);
        setDocuments((current) => current.map((candidate) => {
          if (candidate.path !== change.path || candidate.content !== candidate.savedContent) return candidate;
          return { ...candidate, content: file.content, savedContent: file.content, error: null, externalChanged: false };
        }));
      } catch (caught) {
        setDocuments((current) => current.map((candidate) => candidate.path === change.path
          ? { ...candidate, error: errorMessage(caught), externalChanged: true }
          : candidate));
      }
    }
  }

  async function openDocument(path: string, location?: { line?: number; column?: number }) {
    if (!workspace) return;
    setActivePath(path);
    if (location?.line) {
      setRevealLocation({ path, line: location.line, column: location.column ?? 1, token: Date.now() });
    }
    if (documentsRef.current.some((document) => document.path === path)) return;

    const placeholder: OpenDocument = {
      path,
      kind: isImagePath(path) ? "image" : "text",
      content: "",
      savedContent: "",
      loading: !isImagePath(path),
      error: null,
      externalChanged: false,
      revision: 0
    };
    setDocuments((current) => [...current, placeholder]);
    if (placeholder.kind === "image") return;

    try {
      const loaded = await loadDocument(workspace, path);
      setDocuments((current) => current.map((document) => document.path === path ? loaded : document));
    } catch (caught) {
      setDocuments((current) => current.map((document) => document.path === path
        ? { ...document, loading: false, error: errorMessage(caught) }
        : document));
    }
  }

  function updateActiveDocument(content: string) {
    if (!activePath) return;
    setStatus(null);
    setDocuments((current) => current.map((document) => document.path === activePath ? { ...document, content } : document));
  }

  async function saveActiveDocument(contentOverride?: string) {
    if (!workspace || !activeDocument || activeDocument.kind !== "text" || activeDocument.loading) return;
    const content = contentOverride ?? activeDocument.content;
    if (content === activeDocument.savedContent && !activeDocument.externalChanged) {
      setStatus("No changes to save");
      return;
    }
    setStatus("Saving…");
    setError(null);
    try {
      const saved = await writeFile(workspace, activeDocument.path, content);
      setDocuments((current) => current.map((document) => document.path === activeDocument.path
        ? { ...document, content: saved.content, savedContent: saved.content, error: null, externalChanged: false }
        : document));
      setStatus("Saved");
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    }
  }

  async function reloadDocument(path: string) {
    if (!workspace) return;
    try {
      const loaded = await loadDocument(workspace, path, false);
      setDocuments((current) => current.map((document) => document.path === path ? loaded : document));
      setStatus("Reloaded from disk");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  function closeDocument(path: string) {
    const document = documents.find((candidate) => candidate.path === path);
    if (document && document.content !== document.savedContent && !window.confirm(`Discard changes to ${path}?`)) return;
    const index = documents.findIndex((candidate) => candidate.path === path);
    const remaining = documents.filter((candidate) => candidate.path !== path);
    if (workspace) clearDraftPaths(workspace, (candidate) => candidate === path);
    setDocuments(remaining);
    if (activePath === path) setActivePath(remaining[Math.min(index, remaining.length - 1)]?.path ?? null);
  }

  async function handleCreate(kind: "file" | "directory", parent: string) {
    if (!workspace) return;
    const prefix = parent ? `${parent}/` : "";
    const path = window.prompt(`New ${kind === "file" ? "file" : "folder"} path`, prefix);
    if (!path?.trim()) return;
    try {
      await createEntry(workspace, path.trim(), kind);
      await refreshDirectory(workspace, parentPath(path.trim()));
      if (kind === "file") await openDocument(path.trim());
    } catch (caught) { setError(errorMessage(caught)); }
  }

  async function handleRename(path: string) {
    if (!workspace) return;
    const destination = window.prompt("Rename to", path);
    if (!destination?.trim() || destination.trim() === path) return;
    try {
      await renameEntry(workspace, path, destination.trim());
      const replace = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`)
        ? `${destination.trim()}${candidate.slice(path.length)}`
        : candidate;
      setDocuments((current) => current.map((document) => ({ ...document, path: replace(document.path) })));
      renameDraftPaths(workspace, path, destination.trim());
      setActivePath((current) => current ? replace(current) : null);
      await Promise.all([
        refreshDirectory(workspace, parentPath(path)),
        refreshDirectory(workspace, parentPath(destination.trim()))
      ]);
    } catch (caught) { setError(errorMessage(caught)); }
  }

  async function handleDelete(path: string) {
    if (!workspace || !window.confirm(`Delete ${path}? This cannot be undone.`)) return;
    try {
      await deleteEntry(workspace, path);
      const removed = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
      setDocuments((current) => current.filter((document) => !removed(document.path)));
      clearDraftPaths(workspace, removed);
      if (activePath && removed(activePath)) setActivePath(null);
      await refreshDirectory(workspace, parentPath(path));
    } catch (caught) { setError(errorMessage(caught)); }
  }

  const handleSearch = useCallback(async (query: string) => {
    if (!workspace || !query) { setSearchResults([]); setSearching(false); return; }
    const request = ++searchRequest.current;
    setSearching(true);
    try {
      const results = await searchWorkspace(workspace, query);
      if (request === searchRequest.current) setSearchResults(results);
    } catch (caught) {
      if (request === searchRequest.current) setError(errorMessage(caught));
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  }, [workspace]);

  async function showFilePalette() {
    setPaletteMode("files");
    if (!workspace || quickOpenEntries.length > 0) return;
    const target = workspace;
    setLoadingQuickOpen(true);
    try {
      const entries = await getWorkspaceFiles(target);
      if (workspaceRef.current && workspaceKey(workspaceRef.current) === workspaceKey(target)) {
        setQuickOpenEntries(entries);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingQuickOpen(false);
    }
  }

  function closeWorkspace() {
    if (hasDirtyDocuments && !window.confirm("Close this workspace and discard unsaved changes?")) return;
    if (workspace && hasDirtyDocuments) clearDraftPaths(workspace, () => true);
    setWorkspace(null);
    setTreeEntries([]);
    setQuickOpenEntries([]);
    loadedDirectories.current = new Set();
    setLoadingDirectories(new Set());
    setDocuments([]);
    setActivePath(null);
    setError(null);
    setStatus(null);
  }

  function rememberPath(path: string) {
    setRecentPaths((current) => {
      const next = [path, ...current.filter((recent) => recent !== path)].slice(0, 8);
      window.localStorage.setItem(recentStorageKey, JSON.stringify(next));
      return next;
    });
  }

  return (
    <main className="appShell">
      <header className="titleBar">
        <div className="brandMark">O</div>
        <strong>Oxidize</strong>
        <span className="titleWorkspace">{workspace?.name ?? "Lightweight development environment"}</span>
        <div className="titleStatus">
          {error ? <span className="globalError" title={error}>{error}</span> : status ? <span>{status}</span> : null}
        </div>
      </header>

      <div className="workbench">
        <Sidebar
          workspace={workspace}
          entries={treeEntries}
          activePath={activePath}
          loading={loadingWorkspace}
          onOpenFolder={() => setOpenMode("folder")}
          onOpenFile={() => setOpenMode("file")}
          onCloseWorkspace={closeWorkspace}
          onSelectFile={(path) => void openDocument(path)}
          onCreate={(kind, parent) => void handleCreate(kind, parent)}
          onRename={(path) => void handleRename(path)}
          onDelete={(path) => void handleDelete(path)}
          onExpand={(path) => workspace && void loadTreeDirectory(workspace, path)}
          onRefresh={() => void refreshTree()}
          onSearch={() => setPaletteMode("search")}
          loadingDirectories={loadingDirectories}
        />
        <EditorArea
          workspace={workspace}
          documents={documents}
          activeDocument={activeDocument}
          revealLocation={revealLocation}
          onActivate={setActivePath}
          onClose={closeDocument}
          onChange={updateActiveDocument}
          onSave={saveActiveDocument}
          onReload={(path) => void reloadDocument(path)}
          onOpenFolder={() => setOpenMode("folder")}
          onOpenFile={() => setOpenMode("file")}
          onOpenPath={(path, line, column) => void openDocument(path, { line, column })}
          onQuickOpen={() => void showFilePalette()}
        />
      </div>

      {workspace ? <TerminalLauncher workspace={workspace} /> : null}

      {openMode ? (
        <OpenWorkspaceDialog
          mode={openMode}
          recentPaths={recentPaths}
          loading={loadingWorkspace}
          externalError={error}
          onOpen={handleOpen}
          onClose={() => setOpenMode(null)}
        />
      ) : null}

      {paletteMode ? (
        <WorkspacePalette
          mode={paletteMode}
          entries={paletteMode === "files" ? quickOpenEntries : treeEntries}
          results={searchResults}
          searching={paletteMode === "files" ? loadingQuickOpen : searching}
          onSearch={handleSearch}
          onOpen={(location) => {
            void openDocument(location.path, location);
            setPaletteMode(null);
          }}
          onClose={() => setPaletteMode(null)}
        />
      ) : null}
    </main>
  );
}

async function loadDocument(workspace: WorkspaceInfo, path: string, restoreDraft = true): Promise<OpenDocument> {
  if (isImagePath(path)) {
    return { path, kind: "image", content: "", savedContent: "", loading: false, error: null, externalChanged: false, revision: 0 };
  }
  const file = await readFile(workspace, path);
  const draft = restoreDraft ? readDraft(workspace, path) : null;
  return {
    path,
    kind: "text",
    content: draft?.content ?? file.content,
    savedContent: file.content,
    loading: false,
    error: null,
    externalChanged: Boolean(draft && draft.savedContent !== file.content),
    revision: 0
  };
}

type Draft = { content: string; savedContent: string };
type Session = { paths: string[]; activePath: string | null };

function workspaceKey(workspace: WorkspaceInfo) {
  return `${workspace.root}\u0000${workspace.initial_file ?? ""}`;
}

function parentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function pathDepth(path: string) {
  return path ? path.split("/").length : 0;
}

function replaceDirectoryChildren(current: TreeEntry[], parent: string, children: TreeEntry[]) {
  const nextPaths = new Set(children.map((entry) => entry.path));
  const removedRoots = current
    .filter((entry) => parentPath(entry.path) === parent && !nextPaths.has(entry.path))
    .map((entry) => entry.path);
  const entries = new Map(current
    .filter((entry) => !removedRoots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)))
    .map((entry) => [entry.path, entry]));
  for (const child of children) entries.set(child.path, child);
  return flattenTree(entries);
}

function flattenTree(entries: Map<string, TreeEntry>) {
  const children = new Map<string, TreeEntry[]>();
  for (const entry of entries.values()) {
    const parent = parentPath(entry.path);
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory" ? -1 : 1);
  }
  const result: TreeEntry[] = [];
  const visit = (parent: string) => {
    for (const entry of children.get(parent) ?? []) {
      result.push(entry);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  visit("");
  return result;
}

function readObject<T>(key: string): Record<string, T> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function readDraft(workspace: WorkspaceInfo, path: string) {
  return readObject<Draft>(draftsStorageKey)[`${workspaceKey(workspace)}\u0000${path}`] ?? null;
}

function saveDrafts(workspace: WorkspaceInfo, documents: OpenDocument[]) {
  const drafts = readObject<Draft>(draftsStorageKey);
  const prefix = `${workspaceKey(workspace)}\u0000`;
  for (const document of documents) {
    if (document.kind === "text" && document.content !== document.savedContent) {
      drafts[`${prefix}${document.path}`] = { content: document.content, savedContent: document.savedContent };
    } else {
      delete drafts[`${prefix}${document.path}`];
    }
  }
  window.localStorage.setItem(draftsStorageKey, JSON.stringify(drafts));
}

function clearDraftPaths(workspace: WorkspaceInfo, matches: (path: string) => boolean) {
  const drafts = readObject<Draft>(draftsStorageKey);
  const prefix = `${workspaceKey(workspace)}\u0000`;
  for (const key of Object.keys(drafts)) {
    if (key.startsWith(prefix) && matches(key.slice(prefix.length))) delete drafts[key];
  }
  window.localStorage.setItem(draftsStorageKey, JSON.stringify(drafts));
}

function renameDraftPaths(workspace: WorkspaceInfo, source: string, destination: string) {
  const drafts = readObject<Draft>(draftsStorageKey);
  const prefix = `${workspaceKey(workspace)}\u0000`;
  for (const key of Object.keys(drafts)) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    if (path !== source && !path.startsWith(`${source}/`)) continue;
    drafts[`${prefix}${destination}${path.slice(source.length)}`] = drafts[key];
    delete drafts[key];
  }
  window.localStorage.setItem(draftsStorageKey, JSON.stringify(drafts));
}

function readSession(workspace: WorkspaceInfo) {
  return readObject<Session>(sessionsStorageKey)[workspaceKey(workspace)] ?? null;
}

function saveSession(workspace: WorkspaceInfo, paths: string[], activePath: string | null) {
  const sessions = readObject<Session>(sessionsStorageKey);
  sessions[workspaceKey(workspace)] = { paths, activePath };
  window.localStorage.setItem(sessionsStorageKey, JSON.stringify(sessions));
}

function readRecentPaths() {
  try {
    const value = JSON.parse(window.localStorage.getItem(recentStorageKey) ?? "[]");
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  } catch { return []; }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(<App />);
