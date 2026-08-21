import { lazy, Suspense, useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { WorkspaceInfo } from "../types";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

export function TerminalLauncher({ workspace }: { workspace: WorkspaceInfo }) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  return (
    <>
      {!open ? (
      <button className="terminalLauncher" type="button" onClick={() => { setStarted(true); setOpen(true); }} title="Open terminal">
        <SquareTerminal size={20} />
      </button>
      ) : null}
      {started ? (
        <Suspense fallback={<div className="terminalLauncher loading" />}>
          <TerminalPanel workspace={workspace} visible={open} onMinimize={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
