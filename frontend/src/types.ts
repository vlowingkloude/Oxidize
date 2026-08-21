export type WorkspaceInfo = {
  name: string;
  root: string;
  kind: "folder" | "file";
  initial_file: string | null;
};

export type TreeEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
  depth: number;
};

export type TextFile = {
  path: string;
  content: string;
  size: number;
};

export type OpenDocument = {
  path: string;
  kind: "text" | "image";
  content: string;
  savedContent: string;
  loading: boolean;
  error: string | null;
  externalChanged: boolean;
  revision: number;
};

export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

export type FileChange = {
  kind: "created" | "modified" | "removed" | "resync";
  path: string;
};
