import { useEffect, useRef, useState } from "react";
import { FileCode2, FolderOpen, History, X } from "lucide-react";

type OpenWorkspaceDialogProps = {
  mode: "folder" | "file";
  recentPaths: string[];
  loading: boolean;
  externalError: string | null;
  onOpen: (path: string) => Promise<void>;
  onClose: () => void;
};

export function OpenWorkspaceDialog({
  mode,
  recentPaths,
  loading,
  externalError,
  onOpen,
  onClose
}: OpenWorkspaceDialogProps) {
  const [path, setPath] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const title = mode === "folder" ? "Open folder" : "Open file";

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [loading, onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (path.trim()) await onOpen(path.trim());
  }

  return (
    <div className="dialogBackdrop" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}>
      <section className="openDialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>{mode === "folder" ? <FolderOpen size={20} /> : <FileCode2 size={20} />}<h2>{title}</h2></div>
          <button type="button" onClick={onClose} disabled={loading} title="Close"><X size={18} /></button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="workspacePath">Server path</label>
          <div className="pathInputRow">
            <input
              ref={inputRef}
              id="workspacePath"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={mode === "folder" ? "/home/me/project" : "/home/me/project/src/main.rs"}
              disabled={loading}
            />
            <button type="submit" disabled={loading || !path.trim()}>{loading ? "Opening…" : "Open"}</button>
          </div>
          <small>The path is resolved on the machine running Oxidize.</small>
          {externalError ? <div className="dialogError">{externalError}</div> : null}
        </form>
        {recentPaths.length > 0 ? (
          <section className="recentPaths">
            <div><History size={14} /> Recent</div>
            {recentPaths.map((recent) => (
              <button type="button" key={recent} onClick={() => setPath(recent)} disabled={loading} title={recent}>
                {recent}
              </button>
            ))}
          </section>
        ) : null}
      </section>
    </div>
  );
}

