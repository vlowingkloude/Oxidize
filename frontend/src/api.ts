import type { FileChange, SearchMatch, TextFile, TreeEntry, WorkspaceInfo } from "./types";

export async function getInitialWorkspace() {
  return fetchJson<WorkspaceInfo | null>("/api/workspace");
}

export async function openWorkspace(path: string) {
  return fetchJson<WorkspaceInfo>("/api/workspace/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path })
  });
}

export async function getTree(workspace: WorkspaceInfo, path = "") {
  const params = workspaceParams(workspace);
  if (path) params.set("path", path);
  return fetchJson<TreeEntry[]>(`/api/tree?${params.toString()}`);
}

export async function getWorkspaceFiles(workspace: WorkspaceInfo) {
  return fetchJson<TreeEntry[]>(`/api/files?${workspaceParams(workspace).toString()}`);
}

export async function readFile(workspace: WorkspaceInfo, path: string) {
  return fetchJson<TextFile>("/api/file/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspaceBody(workspace, { path }))
  });
}

export async function writeFile(workspace: WorkspaceInfo, path: string, content: string) {
  return fetchJson<TextFile>("/api/file/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspaceBody(workspace, { path, content }))
  });
}

export async function createEntry(workspace: WorkspaceInfo, path: string, kind: "file" | "directory") {
  return fetchEmpty("/api/file/create", workspaceBody(workspace, { path, kind }));
}

export async function renameEntry(workspace: WorkspaceInfo, path: string, destination: string) {
  return fetchEmpty("/api/file/rename", workspaceBody(workspace, { path, destination }));
}

export async function deleteEntry(workspace: WorkspaceInfo, path: string) {
  return fetchEmpty("/api/file/delete", workspaceBody(workspace, { path }));
}

export async function searchWorkspace(workspace: WorkspaceInfo, query: string, caseSensitive = false) {
  return fetchJson<SearchMatch[]>("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspaceBody(workspace, { query, case_sensitive: caseSensitive }))
  });
}

export function watchWorkspace(workspace: WorkspaceInfo, onChanges: (changes: FileChange[]) => void) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/watch?${workspaceParams(workspace)}`;
  let disposed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  const connect = () => {
    if (disposed) return;
    socket = new WebSocket(url);
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; changes?: FileChange[] };
        if (message.type === "changes" && Array.isArray(message.changes)) onChanges(message.changes);
      } catch {
        // Ignore malformed watcher messages and wait for the next snapshot.
      }
    });
    socket.addEventListener("close", () => {
      if (!disposed) reconnectTimer = window.setTimeout(connect, 2500);
    });
  };
  connect();
  return () => {
    disposed = true;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}

export function imageUrl(workspace: WorkspaceInfo, path: string) {
  const params = workspaceParams(workspace);
  params.set("path", path);
  return `/api/file/raw?${params.toString()}`;
}

export function workspaceParams(workspace: WorkspaceInfo) {
  const params = new URLSearchParams({ root: workspace.root });
  if (workspace.initial_file) {
    params.set("initial_file", workspace.initial_file);
  }
  return params;
}

function workspaceBody(workspace: WorkspaceInfo, values: Record<string, unknown>) {
  return {
    root: workspace.root,
    initial_file: workspace.initial_file,
    ...values
  };
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as T;
}

async function fetchEmpty(input: RequestInfo | URL, body: unknown) {
  const response = await fetch(input, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await readError(response));
}

async function readError(response: Response) {
  const text = await response.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}
