import { Editor, type BeforeMount, type OnMount } from "@monaco-editor/react";
import { AlertTriangle, FileCode2, FolderOpen, ListChecks, RotateCcw, Save, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { imageUrl } from "../api";
import {
  createLspClient,
  type LspDiagnostic,
  type LspStatus,
  supportsLsp,
  type WorkspaceLspClient
} from "../lspClient";
import type { OpenDocument, WorkspaceInfo } from "../types";
import { fileName, fileUri, languageForPath } from "../utils";

type RevealLocation = { path: string; line: number; column: number; token: number } | null;

type EditorAreaProps = {
  workspace: WorkspaceInfo | null;
  documents: OpenDocument[];
  activeDocument: OpenDocument | null;
  revealLocation: RevealLocation;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (content: string) => void;
  onSave: (contentOverride?: string) => Promise<void>;
  onReload: (path: string) => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onOpenPath: (path: string, line: number, column: number) => void;
  onQuickOpen: () => void;
};

export function EditorArea({
  workspace,
  documents,
  activeDocument,
  revealLocation,
  onActivate,
  onClose,
  onChange,
  onSave,
  onReload,
  onOpenFolder,
  onOpenFile,
  onOpenPath,
  onQuickOpen
}: EditorAreaProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const clientsRef = useRef<Map<string, WorkspaceLspClient>>(new Map());
  const openedRef = useRef<Map<string, Set<string>>>(new Map());
  const [mountVersion, setMountVersion] = useState(0);
  const [lspStatuses, setLspStatuses] = useState<Record<string, LspStatus>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, LspDiagnostic[]>>({});
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [formatOnSave, setFormatOnSave] = useState(() => window.localStorage.getItem("oxidize.formatOnSave") === "true");
  const [autoSave, setAutoSave] = useState(() => window.localStorage.getItem("oxidize.autoSave") === "true");
  const [wordWrap, setWordWrap] = useState(() => window.localStorage.getItem("oxidize.wordWrap") !== "false");
  const language = activeDocument ? languageForPath(activeDocument.path) : "plaintext";
  const allDiagnostics = useMemo(() => Object.values(diagnostics).flat(), [diagnostics]);
  const lspStatus = lspStatuses[language] ?? "closed";

  useEffect(() => {
    for (const client of clientsRef.current.values()) client.dispose();
    clientsRef.current.clear();
    openedRef.current.clear();
    setLspStatuses({});
    setDiagnostics({});
    return () => {
      for (const client of clientsRef.current.values()) client.dispose();
      clientsRef.current.clear();
      openedRef.current.clear();
    };
  }, [workspace?.root, workspace?.initial_file]);

  useEffect(() => {
    const editor = editorRef.current;
    const monacoApi = monacoRef.current;
    if (!workspace || !activeDocument || activeDocument.kind !== "text" || activeDocument.loading || activeDocument.error || !supportsLsp(language) || !editor || !monacoApi) return;

    let client = clientsRef.current.get(language);
    if (!client) {
      client = createLspClient({
        monacoApi,
        workspace,
        language,
        onStatusChange: (status) => setLspStatuses((current) => ({ ...current, [language]: status })),
        onDiagnostics: (path, next) => setDiagnostics((current) => ({ ...current, [path]: next }))
      });
      clientsRef.current.set(language, client);
      openedRef.current.set(language, new Set());
      client.start();
    }
    const model = editor.getModel();
    if (!model || model.uri.toString() !== fileUri(workspace.root, activeDocument.path)) return;
    client.openDocument(activeDocument.path, model);
    openedRef.current.get(language)?.add(activeDocument.path);
  }, [activeDocument?.path, activeDocument?.kind, activeDocument?.loading, activeDocument?.error, language, mountVersion, workspace?.root, workspace?.initial_file]);

  useEffect(() => {
    const paths = new Set(documents.map((document) => document.path));
    for (const [clientLanguage, opened] of openedRef.current) {
      const client = clientsRef.current.get(clientLanguage);
      if (!client) continue;
      for (const path of [...opened]) {
        if (!paths.has(path)) {
          client.closeDocument(path);
          opened.delete(path);
        }
      }
    }
  }, [documents]);

  useEffect(() => {
    if (!revealLocation || revealLocation.path !== activeDocument?.path) return;
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const position = { lineNumber: revealLocation.line, column: revealLocation.column };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    });
  }, [activeDocument?.path, mountVersion, revealLocation?.token]);

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o" && editorRef.current) {
        event.preventDefault();
        void editorRef.current.getAction("editor.action.quickOutline")?.run();
      }
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  });

  useEffect(() => {
    if (!autoSave || !activeDocument || activeDocument.kind !== "text" || activeDocument.loading || activeDocument.error || activeDocument.externalChanged || activeDocument.content === activeDocument.savedContent) return;
    const timer = window.setTimeout(() => void saveActive(), 1000);
    return () => window.clearTimeout(timer);
  }, [
    activeDocument?.content,
    activeDocument?.error,
    activeDocument?.externalChanged,
    activeDocument?.loading,
    activeDocument?.path,
    activeDocument?.savedContent,
    autoSave,
    formatOnSave,
    lspStatus
  ]);

  const beforeMount: BeforeMount = (monacoApi) => {
    monacoApi.editor.defineTheme("oxidize-solarized-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "93a1a1", fontStyle: "italic" },
        { token: "string", foreground: "2aa198" },
        { token: "number", foreground: "d33682" },
        { token: "keyword", foreground: "859900" },
        { token: "type", foreground: "b58900" },
        { token: "type.identifier", foreground: "b58900" },
        { token: "identifier", foreground: "657b83" },
        { token: "delimiter", foreground: "586e75" }
      ],
      colors: {
        "editor.background": "#fdf6e3", "editor.foreground": "#657b83", "editorGutter.background": "#fdf6e3",
        "editorLineNumber.foreground": "#93a1a1", "editorLineNumber.activeForeground": "#586e75",
        "editorCursor.foreground": "#cb4b16", "editor.selectionBackground": "#d7e3e3",
        "editor.inactiveSelectionBackground": "#e5e1d5", "editor.lineHighlightBackground": "#eee8d5",
        "editorWhitespace.foreground": "#d8d2c2", "editorIndentGuide.background1": "#e1dccd",
        "editorIndentGuide.activeBackground1": "#b8b3a7", "editorWidget.background": "#eee8d5",
        "editorSuggestWidget.background": "#fdf6e3", "editorSuggestWidget.selectedBackground": "#e1e7df"
      }
    });
  };

  const handleMount: OnMount = (editor, monacoApi) => {
    editorRef.current = editor;
    monacoRef.current = monacoApi;
    setMountVersion((version) => version + 1);
  };

  function formatActive() {
    if (!activeDocument) return;
    void clientsRef.current.get(language)?.format(activeDocument.path);
  }

  async function saveActive() {
    if (!activeDocument) return;
    const client = clientsRef.current.get(language);
    if (formatOnSave && client && lspStatus === "ready") await client.format(activeDocument.path);
    const currentContent = editorRef.current?.getModel()?.uri.toString() === fileUri(workspace!.root, activeDocument.path)
      ? editorRef.current.getValue()
      : activeDocument.content;
    await onSave(currentContent);
    client?.didSave(activeDocument.path);
  }

  if (!workspace) {
    return (
      <section className="editorArea welcomeArea">
        <div className="welcomeMark">O</div>
        <h1>Oxidize</h1>
        <p>A small, focused place to read, write, and run code.</p>
        <div className="welcomeActions">
          <button type="button" onClick={onOpenFolder}><FolderOpen size={17} /> Open Folder <kbd>Ctrl O</kbd></button>
          <button type="button" onClick={onOpenFile}><FileCode2 size={17} /> Open File <kbd>Ctrl Alt O</kbd></button>
        </div>
      </section>
    );
  }

  return (
    <section className="editorArea">
      <div className="editorTabs">
        {documents.map((document) => {
          const dirty = document.content !== document.savedContent;
          return (
            <button type="button" key={document.path} className={`editorTab${activeDocument?.path === document.path ? " active" : ""}`} onClick={() => onActivate(document.path)} title={document.path}>
              <span className={dirty ? "dirtyDot" : "fileDot"}>{dirty ? "●" : document.externalChanged ? "!" : ""}</span>
              <span>{fileName(document.path)}</span>
              <span className="closeTab" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onClose(document.path); }} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); onClose(document.path); }
              }}><X size={13} /></span>
            </button>
          );
        })}
      </div>

      {activeDocument ? (
        <>
          <div className="editorToolbar">
            <div className="breadcrumbs">{activeDocument.path.split("/").map((part, index) => <span key={`${part}-${index}`}>{part}</span>)}</div>
            <div className="editorMeta">
              {supportsLsp(language) && activeDocument.kind === "text" ? <span className={`lspStatus ${lspStatus}`}>{language}: {lspStatus}</span> : null}
              {allDiagnostics.length ? <button type="button" onClick={() => setProblemsOpen((value) => !value)}><ListChecks size={14} /> {allDiagnostics.length} Problems</button> : null}
              <label className="saveOption" title="Wrap long lines at the editor width"><input type="checkbox" checked={wordWrap} onChange={(event) => { setWordWrap(event.target.checked); window.localStorage.setItem("oxidize.wordWrap", String(event.target.checked)); }} /> Wrap</label>
              <label className="saveOption" title="Automatically save one second after typing"><input type="checkbox" checked={autoSave} onChange={(event) => { setAutoSave(event.target.checked); window.localStorage.setItem("oxidize.autoSave", String(event.target.checked)); }} /> Auto</label>
              <label className="saveOption" title="Format with the language server before saving"><input type="checkbox" checked={formatOnSave} onChange={(event) => { setFormatOnSave(event.target.checked); window.localStorage.setItem("oxidize.formatOnSave", String(event.target.checked)); }} /> Format on save</label>
              {supportsLsp(language) && activeDocument.kind === "text" ? <button type="button" onClick={formatActive} disabled={lspStatus !== "ready"} title="Format document (Shift+Alt+F)"><Sparkles size={14} /> Format</button> : null}
              {activeDocument.kind === "text" ? <button type="button" onClick={saveActive} disabled={activeDocument.content === activeDocument.savedContent && !activeDocument.externalChanged || activeDocument.loading} title="Save (Ctrl+S)"><Save size={15} /> Save</button> : null}
            </div>
          </div>
          <div className="editorSurface">
            {activeDocument.externalChanged ? (
              <div className="externalChangeBanner">
                <AlertTriangle size={14} /> The file changed on disk.
                <button type="button" onClick={() => onReload(activeDocument.path)}><RotateCcw size={13} /> Reload</button>
                <span>Save to overwrite the disk version.</span>
              </div>
            ) : null}
            {activeDocument.loading ? <div className="editorMessage">Opening {activeDocument.path}…</div> : null}
            {activeDocument.error ? <div className="editorMessage errorMessage">{activeDocument.error}</div> : null}
            {!activeDocument.loading && !activeDocument.error && activeDocument.kind === "image" ? (
              <div className="imagePreview"><img src={`${imageUrl(workspace, activeDocument.path)}&v=${activeDocument.revision}`} alt={activeDocument.path} /><span>{activeDocument.path}</span></div>
            ) : null}
            {!activeDocument.loading && !activeDocument.error && activeDocument.kind === "text" ? (
              <Editor
                height="100%"
                beforeMount={beforeMount}
                onMount={handleMount}
                language={language}
                path={fileUri(workspace.root, activeDocument.path)}
                value={activeDocument.content}
                onChange={(value) => onChange(value ?? "")}
                theme="oxidize-solarized-light"
                saveViewState
                keepCurrentModel
                options={{
                  automaticLayout: true, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
                  fontSize: 14, lineHeight: 22, minimap: { enabled: true, scale: 1 }, padding: { top: activeDocument.externalChanged ? 43 : 10 },
                  scrollBeyondLastLine: false, smoothScrolling: true, bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: true, indentation: true }, renderWhitespace: "selection", wordWrap: wordWrap ? "on" : "off"
                }}
              />
            ) : null}
            {problemsOpen ? (
              <section className="problemsPanel">
                <header><strong>Problems ({allDiagnostics.length})</strong><button type="button" onClick={() => setProblemsOpen(false)}><X size={14} /></button></header>
                <div>{allDiagnostics.map((diagnostic, index) => (
                  <button type="button" key={`${diagnostic.path}-${index}`} onClick={() => onOpenPath(diagnostic.path, diagnostic.range.start.line + 1, diagnostic.range.start.character + 1)}>
                    <AlertTriangle size={14} /><span><strong>{diagnostic.message}</strong><small>{diagnostic.path}:{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}</small></span>
                  </button>
                ))}</div>
              </section>
            ) : null}
          </div>
        </>
      ) : (
        <div className="noEditor">
          <FileCode2 size={38} />
          <p>Select a file from the Explorer to begin.</p>
          <button type="button" className="quickOpenLink" onClick={onQuickOpen}>Quick Open <kbd>Ctrl P</kbd></button>
        </div>
      )}
    </section>
  );
}
