import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Maximize2, Minimize2, Minus, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { workspaceParams } from "../api";
import type { WorkspaceInfo } from "../types";
import "@xterm/xterm/css/xterm.css";

type ServerMessage =
  | { type: "output"; data: string }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null };
type Status = "connecting" | "connected" | "closed" | "exited";
type SessionInfo = { id: number; generation: number; status: Status };

export function TerminalPanel({ workspace, visible, onMinimize }: { workspace: WorkspaceInfo; visible: boolean; onMinimize: () => void }) {
  const nextId = useRef(2);
  const [expanded, setExpanded] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([{ id: 1, generation: 0, status: "connecting" }]);
  const [activeId, setActiveId] = useState(1);

  function addSession() {
    const id = nextId.current++;
    setSessions((current) => [...current, { id, generation: 0, status: "connecting" }]);
    setActiveId(id);
  }

  function closeSession(id: number) {
    if (sessions.length === 1) {
      const replacement = { id: nextId.current++, generation: 0, status: "connecting" as const };
      setSessions([replacement]);
      setActiveId(replacement.id);
      return;
    }
    const index = sessions.findIndex((session) => session.id === id);
    const remaining = sessions.filter((session) => session.id !== id);
    setSessions(remaining);
    if (activeId === id) setActiveId(remaining[Math.min(index, remaining.length - 1)].id);
  }

  return (
    <section className={`terminalPanel${expanded ? " expanded" : ""}${visible ? "" : " hidden"}`}>
      <header>
        <div className="terminalTabs">
          <SquareTerminal size={15} />
          {sessions.map((session, index) => (
            <button type="button" key={session.id} className={`terminalTab${activeId === session.id ? " active" : ""}`} onClick={() => setActiveId(session.id)}>
              <span>{index + 1}</span><span className={`terminalStatus ${session.status}`}>●</span>
              <span role="button" className="terminalTabClose" onClick={(event) => { event.stopPropagation(); closeSession(session.id); }}><X size={11} /></span>
            </button>
          ))}
          <button type="button" onClick={addSession} title="New terminal"><Plus size={14} /></button>
        </div>
        <div>
          <button type="button" onClick={() => setSessions((current) => current.map((session) => session.id === activeId ? { ...session, generation: session.generation + 1, status: "connecting" } : session))} title="Restart terminal"><RotateCw size={15} /></button>
          <button type="button" onClick={() => setExpanded((value) => !value)} title="Resize terminal">{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          <button type="button" onClick={onMinimize} title="Minimize terminal"><Minus size={16} /></button>
        </div>
      </header>
      <div className="terminalSessions">
        {sessions.map((session) => (
          <TerminalSession
            key={session.id}
            workspace={workspace}
            generation={session.generation}
            visible={visible && activeId === session.id}
            onStatus={(status) => setSessions((current) => current.map((candidate) => candidate.id === session.id ? { ...candidate, status } : candidate))}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalSession({ workspace, generation, visible, onStatus }: { workspace: WorkspaceInfo; generation: number; visible: boolean; onStatus: (status: Status) => void }) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!surfaceRef.current) return;
    const surface = surfaceRef.current;
    const terminal = new Terminal({
      cursorBlink: true, convertEol: true, fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", fontSize: 13, lineHeight: 1.25,
      theme: {
        background: "#fdf6e3", foreground: "#657b83", cursor: "#cb4b16", cursorAccent: "#fdf6e3", selectionBackground: "#d7e3e3",
        black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
        brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface);
    fitRef.current = fit;
    const socket = new WebSocket(terminalUrl(workspace));
    let exited = false;
    onStatus("connecting");
    const fitAndResize = () => {
      if (!visibleRef.current) return;
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      } catch { /* Hidden or resizing surfaces can briefly have no measurable size. */ }
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(surface);
    socket.addEventListener("open", () => { onStatus("connected"); fitAndResize(); if (visibleRef.current) terminal.focus(); });
    socket.addEventListener("message", (event) => {
      const message = parseMessage(event.data);
      if (!message) return;
      if (message.type === "output") terminal.write(message.data);
      if (message.type === "error") terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
      if (message.type === "exit") { exited = true; onStatus("exited"); terminal.writeln(`\r\n\x1b[90mProcess exited${message.code == null ? "" : ` with ${message.code}`}.\x1b[0m`); }
    });
    socket.addEventListener("close", () => { if (!exited) onStatus("closed"); });
    socket.addEventListener("error", () => { onStatus("closed"); terminal.writeln("\r\n\x1b[31mTerminal connection failed.\x1b[0m"); });
    const input = terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
    requestAnimationFrame(fitAndResize);
    return () => { input.dispose(); observer.disconnect(); socket.close(); terminal.dispose(); fitRef.current = null; };
  }, [generation, workspace.root, workspace.initial_file]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => fitRef.current?.fit());
  }, [visible]);

  return <div ref={surfaceRef} className={`terminalSurface${visible ? " active" : ""}`} />;
}

function terminalUrl(workspace: WorkspaceInfo) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminal?${workspaceParams(workspace).toString()}`;
}

function parseMessage(value: unknown): ServerMessage | null {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as ServerMessage; } catch { return null; }
}
