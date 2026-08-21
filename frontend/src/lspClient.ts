import type * as monaco from "monaco-editor";
import { workspaceParams } from "./api";
import type { WorkspaceInfo } from "./types";
import { fileUri } from "./utils";

type Monaco = typeof monaco;
type MonacoModel = monaco.editor.ITextModel;
type Disposable = monaco.IDisposable;
type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri?: string; range?: Range; targetUri?: string; targetRange?: Range; targetSelectionRange?: Range };
type Diagnostic = { range: Range; severity?: number; message: string; source?: string; code?: string | number };
type TextEdit = { range: Range; newText: string };
type InsertReplaceEdit = { insert: Range; replace: Range; newText: string };
type CompletionItem = {
  label: string | { label: string };
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: TextEdit | InsertReplaceEdit;
};
type Hover = { contents: string | { value: string } | Array<string | { value: string }>; range?: Range };
type WorkspaceEdit = { changes?: Record<string, TextEdit[]> };
type LspCodeAction = { title: string; kind?: string; edit?: WorkspaceEdit; command?: { command: string; arguments?: unknown[] } };
type DocumentSymbol = {
  name: string;
  detail?: string;
  kind?: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
};
type InlayHint = {
  position: Position;
  label: string | Array<{ value: string; tooltip?: string | { value: string } }>;
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
};
type Message = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export type LspStatus = "connecting" | "ready" | "closed" | "error";
export type LspDiagnostic = Diagnostic & { path: string };

type Options = {
  monacoApi: Monaco;
  workspace: WorkspaceInfo;
  language: string;
  onStatusChange: (status: LspStatus) => void;
  onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void;
};

type OpenDocument = {
  path: string;
  uri: string;
  model: MonacoModel;
  version: number;
  changeDisposable: Disposable;
  changeTimer: number | null;
};

export function createLspClient(options: Options) {
  return new WorkspaceLspClient(options);
}

export function supportsLsp(language: string) {
  return [
    "rust", "go", "python", "cpp", "java", "typescript", "javascript",
    "shell", "toml", "json", "html", "css", "scss", "yaml",
    "dockerfile", "markdown", "lua"
  ].includes(language);
}

export class WorkspaceLspClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private ready = false;
  private closed = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private disposables: Disposable[] = [];
  private documents = new Map<string, OpenDocument>();
  private readonly rootUri: string;

  constructor(private readonly options: Options) {
    this.rootUri = fileUri(options.workspace.root, "");
  }

  start() {
    this.options.onStatusChange("connecting");
    this.registerProviders();
    this.socket = new WebSocket(lspUrl(this.options.workspace, this.options.language));
    this.socket.addEventListener("open", () => void this.initialize());
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => { if (!this.closed) this.options.onStatusChange("closed"); });
    this.socket.addEventListener("error", () => { if (!this.closed) this.options.onStatusChange("error"); });
  }

  openDocument(path: string, model: MonacoModel) {
    const uri = model.uri.toString();
    const existing = this.documents.get(uri);
    if (existing?.model === model) return;
    if (existing) this.closeDocument(existing.path);
    const document: OpenDocument = {
      path,
      uri,
      model,
      version: 1,
      changeTimer: null,
      changeDisposable: model.onDidChangeContent(() => this.scheduleChange(uri))
    };
    this.documents.set(uri, document);
    if (this.ready) this.didOpen(document);
  }

  closeDocument(path: string) {
    const document = [...this.documents.values()].find((candidate) => candidate.path === path);
    if (!document) return;
    if (document.changeTimer != null) window.clearTimeout(document.changeTimer);
    document.changeDisposable.dispose();
    if (this.ready) this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
    this.options.monacoApi.editor.setModelMarkers(document.model, `oxidize-${this.options.language}`, []);
    this.options.onDiagnostics(path, []);
    this.documents.delete(document.uri);
  }

  didSave(path: string) {
    const document = [...this.documents.values()].find((candidate) => candidate.path === path);
    if (this.ready && document) {
      this.flushChange(document);
      this.notify("textDocument/didSave", { textDocument: { uri: document.uri } });
    }
  }

  async format(path: string) {
    const document = [...this.documents.values()].find((candidate) => candidate.path === path);
    if (!this.ready || !document) return false;
    this.flushChange(document);
    try {
      const edits = await this.request("textDocument/formatting", {
        textDocument: { uri: document.uri },
        options: { tabSize: document.model.getOptions().tabSize, insertSpaces: document.model.getOptions().insertSpaces }
      }) as TextEdit[] | null;
      if (!edits?.length) return false;
      document.model.pushEditOperations([], edits.map((edit) => ({
        range: fromLspRange(this.options.monacoApi, edit.range),
        text: edit.newText
      })), () => null);
      return true;
    } catch { return false; }
  }

  dispose() {
    this.closed = true;
    this.ready = false;
    for (const document of [...this.documents.values()]) this.closeDocument(document.path);
    this.disposables.forEach((disposable) => disposable.dispose());
    this.pending.forEach(({ reject }) => reject(new Error("language client closed")));
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }

  private async initialize() {
    try {
      await this.request("initialize", {
        processId: null,
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: this.options.workspace.name }],
        capabilities: {
          workspace: { configuration: true, workspaceEdit: { documentChanges: true } },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: true } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: {}, references: {}, rename: { prepareSupport: false }, formatting: {}, documentSymbol: {}, inlayHint: {},
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor"] } } },
            publishDiagnostics: { relatedInformation: true }
          }
        }
      });
      this.notify("initialized", {});
      for (const document of this.documents.values()) this.didOpen(document);
      this.ready = true;
      this.options.onStatusChange("ready");
    } catch {
      this.options.onStatusChange("error");
    }
  }

  private didOpen(document: OpenDocument) {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: document.uri,
        languageId: this.options.language,
        version: document.version,
        text: document.model.getValue()
      }
    });
  }

  private registerProviders() {
    const language = this.options.language;
    const api = this.options.monacoApi;
    const executeCommandId = `oxidize.lsp.execute.${language}`;
    this.disposables.push(
      api.editor.registerCommand(executeCommandId, (_accessor, command: unknown, args: unknown) => {
        if (typeof command === "string") void this.request("workspace/executeCommand", { command, arguments: Array.isArray(args) ? args : [] });
      }),
      api.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", ":", ">", "/"],
        provideCompletionItems: (model, position) => this.completions(model, position)
      }),
      api.languages.registerHoverProvider(language, { provideHover: (model, position) => this.hover(model, position) }),
      api.languages.registerDefinitionProvider(language, { provideDefinition: (model, position) => this.locations("textDocument/definition", model, position) }),
      api.languages.registerReferenceProvider(language, {
        provideReferences: (model, position, context) => this.locations("textDocument/references", model, position, { context })
      }),
      api.languages.registerRenameProvider(language, {
        provideRenameEdits: (model, position, newName) => this.rename(model, position, newName)
      }),
      api.languages.registerDocumentFormattingEditProvider(language, {
        provideDocumentFormattingEdits: (model, options) => this.formattingEdits(model, options)
      }),
      api.languages.registerDocumentSymbolProvider(language, {
        provideDocumentSymbols: (model) => this.documentSymbols(model)
      }),
      api.languages.registerInlayHintsProvider(language, {
        provideInlayHints: (model, range) => this.inlayHints(model, range)
      }),
      api.languages.registerCodeActionProvider(language, {
        provideCodeActions: (model, range, context) => this.codeActions(model, range, context)
      }, { providedCodeActionKinds: ["quickfix", "refactor"] })
    );
  }

  private handleMessage(data: unknown) {
    if (typeof data !== "string") return;
    let message: Message;
    try { message = JSON.parse(data) as Message; } catch { return; }
    if (typeof message.id === "number" && message.method) {
      const configurationItems = (message.params as { items?: unknown[] } | null)?.items;
      const result = message.method === "workspace/configuration"
        ? Array.from({ length: configurationItems?.length ?? 1 }, () => ({}))
        : null;
      this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "language server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") this.updateDiagnostics(message.params);
  }

  private updateDiagnostics(params: unknown) {
    const payload = params as { uri?: string; diagnostics?: Diagnostic[] };
    if (!payload.uri) return;
    const document = this.documents.get(payload.uri);
    const model = document?.model ?? this.options.monacoApi.editor.getModel(this.options.monacoApi.Uri.parse(payload.uri));
    if (!document || !model) return;
    const diagnostics = payload.diagnostics ?? [];
    this.options.monacoApi.editor.setModelMarkers(model, `oxidize-${this.options.language}`, diagnostics.map((diagnostic) => ({
      ...monacoRange(diagnostic.range),
      severity: markerSeverity(this.options.monacoApi, diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source,
      code: diagnostic.code == null ? undefined : String(diagnostic.code)
    })));
    this.options.onDiagnostics(document.path, diagnostics.map((diagnostic) => ({ ...diagnostic, path: document.path })));
  }

  private scheduleChange(uri: string) {
    const document = this.documents.get(uri);
    if (!document || !this.ready) return;
    if (document.changeTimer != null) window.clearTimeout(document.changeTimer);
    document.changeTimer = window.setTimeout(() => {
      this.flushChange(document);
    }, 180);
  }

  private flushChange(document: OpenDocument) {
    if (!this.ready || document.changeTimer == null) return;
    window.clearTimeout(document.changeTimer);
    document.changeTimer = null;
    document.version += 1;
    this.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges: [{ text: document.model.getValue() }]
    });
  }

  private async completions(model: MonacoModel, position: monaco.Position): Promise<monaco.languages.CompletionList | null> {
    const document = this.activeDocument(model);
    if (!document) return null;
    this.flushChange(document);
    try {
      const result = await this.request("textDocument/completion", {
        textDocument: { uri: document.uri }, position: lspPosition(position)
      });
      const items = Array.isArray(result) ? result as CompletionItem[] : (result as { items?: CompletionItem[] } | null)?.items;
      if (!items) return null;
      const word = model.getWordUntilPosition(position);
      const defaultRange = new this.options.monacoApi.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { suggestions: items.map((item) => ({
        label: typeof item.label === "string" ? item.label : item.label.label,
        kind: completionKind(this.options.monacoApi, item.kind),
        detail: item.detail,
        documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
        insertText: item.textEdit?.newText ?? item.insertText ?? (typeof item.label === "string" ? item.label : item.label.label),
        insertTextRules: item.insertTextFormat === 2 ? this.options.monacoApi.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range: item.textEdit ? fromLspRange(this.options.monacoApi, "range" in item.textEdit ? item.textEdit.range : item.textEdit.replace) : defaultRange
      })) };
    } catch { return null; }
  }

  private async hover(model: MonacoModel, position: monaco.Position): Promise<monaco.languages.Hover | null> {
    const document = this.activeDocument(model);
    if (!document) return null;
    this.flushChange(document);
    try {
      const result = await this.request("textDocument/hover", {
        textDocument: { uri: document.uri }, position: lspPosition(position)
      }) as Hover | null;
      if (!result) return null;
      const values = Array.isArray(result.contents) ? result.contents : [result.contents];
      return {
        contents: values.map((value) => ({ value: typeof value === "string" ? value : value.value })),
        range: result.range ? fromLspRange(this.options.monacoApi, result.range) : undefined
      };
    } catch { return null; }
  }

  private async locations(method: string, model: MonacoModel, position: monaco.Position, extra: object = {}): Promise<monaco.languages.Location[] | null> {
    const document = this.activeDocument(model);
    if (!document) return null;
    this.flushChange(document);
    try {
      const result = await this.request(method, {
        textDocument: { uri: document.uri }, position: lspPosition(position), ...extra
      });
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      return locations.map((value) => {
        const location = value as Location;
        return {
          uri: this.options.monacoApi.Uri.parse(location.uri ?? location.targetUri ?? ""),
          range: fromLspRange(this.options.monacoApi, location.range ?? location.targetSelectionRange ?? location.targetRange ?? emptyRange())
        };
      });
    } catch { return null; }
  }

  private async rename(model: MonacoModel, position: monaco.Position, newName: string): Promise<monaco.languages.WorkspaceEdit | null> {
    const document = this.activeDocument(model);
    if (!document) return null;
    this.flushChange(document);
    try {
      const edit = await this.request("textDocument/rename", {
        textDocument: { uri: document.uri }, position: lspPosition(position), newName
      }) as WorkspaceEdit | null;
      return edit ? toMonacoWorkspaceEdit(this.options.monacoApi, edit) : null;
    } catch { return null; }
  }

  private async formattingEdits(model: MonacoModel, options: monaco.languages.FormattingOptions): Promise<monaco.languages.TextEdit[]> {
    const document = this.activeDocument(model);
    if (!document) return [];
    this.flushChange(document);
    try {
      const edits = await this.request("textDocument/formatting", {
        textDocument: { uri: document.uri }, options
      }) as TextEdit[] | null;
      return (edits ?? []).map((edit) => ({ range: fromLspRange(this.options.monacoApi, edit.range), text: edit.newText }));
    } catch { return []; }
  }

  private async documentSymbols(model: MonacoModel): Promise<monaco.languages.DocumentSymbol[]> {
    const document = this.activeDocument(model);
    if (!document) return [];
    this.flushChange(document);
    try {
      const symbols = await this.request("textDocument/documentSymbol", {
        textDocument: { uri: document.uri }
      }) as DocumentSymbol[] | null;
      const convert = (symbol: DocumentSymbol): monaco.languages.DocumentSymbol => ({
        name: symbol.name,
        detail: symbol.detail ?? "",
        kind: symbolKind(this.options.monacoApi, symbol.kind),
        tags: [],
        range: fromLspRange(this.options.monacoApi, symbol.range),
        selectionRange: fromLspRange(this.options.monacoApi, symbol.selectionRange),
        children: symbol.children?.map(convert)
      });
      return (symbols ?? []).filter((symbol) => "selectionRange" in symbol).map(convert);
    } catch { return []; }
  }

  private async inlayHints(model: MonacoModel, range: monaco.Range): Promise<monaco.languages.InlayHintList> {
    const document = this.activeDocument(model);
    if (!document) return { hints: [], dispose() {} };
    this.flushChange(document);
    try {
      const hints = await this.request("textDocument/inlayHint", {
        textDocument: { uri: document.uri }, range: toLspRange(range)
      }) as InlayHint[] | null;
      return {
        hints: (hints ?? []).map((hint) => ({
          position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
          label: typeof hint.label === "string" ? hint.label : hint.label.map((part) => ({
            label: part.value,
            tooltip: typeof part.tooltip === "string" ? part.tooltip : part.tooltip?.value
          })),
          kind: hint.kind === 1 ? this.options.monacoApi.languages.InlayHintKind.Type : hint.kind === 2 ? this.options.monacoApi.languages.InlayHintKind.Parameter : undefined,
          paddingLeft: hint.paddingLeft,
          paddingRight: hint.paddingRight
        })),
        dispose() {}
      };
    } catch { return { hints: [], dispose() {} }; }
  }

  private async codeActions(model: MonacoModel, range: monaco.Range, context: monaco.languages.CodeActionContext): Promise<monaco.languages.CodeActionList> {
    const document = this.activeDocument(model);
    if (!document) return { actions: [], dispose() {} };
    this.flushChange(document);
    try {
      const actions = await this.request("textDocument/codeAction", {
        textDocument: { uri: document.uri },
        range: toLspRange(range),
        context: { diagnostics: context.markers.map((marker) => ({
          range: toLspRange(marker), message: marker.message, severity: fromMarkerSeverity(this.options.monacoApi, marker.severity), source: marker.source, code: marker.code
        })) }
      }) as LspCodeAction[] | null;
      return {
        actions: (actions ?? []).map((action) => ({
          title: action.title,
          kind: action.kind,
          edit: action.edit ? toMonacoWorkspaceEdit(this.options.monacoApi, action.edit) : undefined,
          command: action.command ? {
            id: `oxidize.lsp.execute.${this.options.language}`,
            title: action.title,
            arguments: [action.command.command, action.command.arguments ?? []]
          } : undefined
        })),
        dispose() {}
      };
    } catch { return { actions: [], dispose() {} }; }
  }

  private activeDocument(model: MonacoModel) {
    return this.ready ? this.documents.get(model.uri.toString()) ?? null : null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown) { this.send({ jsonrpc: "2.0", method, params }); }
  private send(message: Message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

function lspUrl(workspace: WorkspaceInfo, language: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = workspaceParams(workspace);
  params.set("language", language);
  return `${protocol}//${window.location.host}/api/lsp?${params.toString()}`;
}

function lspPosition(position: monaco.Position): Position { return { line: position.lineNumber - 1, character: position.column - 1 }; }
function toLspRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): Range {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
  };
}
function monacoRange(range: Range) {
  return { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 };
}
function fromLspRange(api: Monaco, range: Range) {
  return new api.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
}
function toMonacoWorkspaceEdit(api: Monaco, edit: WorkspaceEdit): monaco.languages.WorkspaceEdit {
  return { edits: Object.entries(edit.changes ?? {}).flatMap(([uri, edits]) => edits.map((item) => ({
    resource: api.Uri.parse(uri), textEdit: { range: fromLspRange(api, item.range), text: item.newText }, versionId: undefined
  }))) };
}
function markerSeverity(api: Monaco, severity = 3) {
  if (severity === 1) return api.MarkerSeverity.Error;
  if (severity === 2) return api.MarkerSeverity.Warning;
  if (severity === 4) return api.MarkerSeverity.Hint;
  return api.MarkerSeverity.Info;
}
function fromMarkerSeverity(api: Monaco, severity: monaco.MarkerSeverity) {
  if (severity === api.MarkerSeverity.Error) return 1;
  if (severity === api.MarkerSeverity.Warning) return 2;
  if (severity === api.MarkerSeverity.Hint) return 4;
  return 3;
}
function completionKind(api: Monaco, kind = 1) {
  const kinds = api.languages.CompletionItemKind;
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    2: kinds.Method, 3: kinds.Function, 4: kinds.Constructor, 5: kinds.Field, 6: kinds.Variable,
    7: kinds.Class, 8: kinds.Interface, 9: kinds.Module, 10: kinds.Property, 11: kinds.Unit,
    12: kinds.Value, 13: kinds.Enum, 14: kinds.Keyword, 15: kinds.Snippet, 17: kinds.File,
    18: kinds.Reference, 20: kinds.EnumMember, 21: kinds.Constant, 22: kinds.Struct, 23: kinds.Event,
    24: kinds.Operator, 25: kinds.TypeParameter
  };
  return map[kind] ?? kinds.Text;
}
function symbolKind(api: Monaco, kind = 13) {
  const kinds = api.languages.SymbolKind;
  const map: Record<number, monaco.languages.SymbolKind> = {
    1: kinds.File, 2: kinds.Module, 3: kinds.Namespace, 4: kinds.Package, 5: kinds.Class,
    6: kinds.Method, 7: kinds.Property, 8: kinds.Field, 9: kinds.Constructor, 10: kinds.Enum,
    11: kinds.Interface, 12: kinds.Function, 13: kinds.Variable, 14: kinds.Constant, 15: kinds.String,
    16: kinds.Number, 17: kinds.Boolean, 18: kinds.Array, 19: kinds.Object, 20: kinds.Key,
    21: kinds.Null, 22: kinds.EnumMember, 23: kinds.Struct, 24: kinds.Event, 25: kinds.Operator,
    26: kinds.TypeParameter
  };
  return map[kind] ?? kinds.Variable;
}
function emptyRange(): Range { return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }; }
