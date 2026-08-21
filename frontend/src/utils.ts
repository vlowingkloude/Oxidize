const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);

export function isImagePath(path: string) {
  return imageExtensions.has(extension(path));
}

export function languageForPath(path: string) {
  const ext = extension(path);
  const languages: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    go: "go",
    lua: "lua",
    c: "cpp",
    cc: "cpp",
    cpp: "cpp",
    h: "cpp",
    hpp: "cpp",
    java: "java",
    sh: "shell",
    bash: "shell",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
    toml: "toml"
  };
  if (path.endsWith("Cargo.lock")) return "ini";
  if (path.endsWith("Dockerfile")) return "dockerfile";
  return languages[ext] ?? "plaintext";
}

export function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

export function parentPaths(path: string) {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

export function fileUri(root: string, path: string) {
  const joined = `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return `file://${joined.split("/").map(encodeURIComponent).join("/")}`;
}

function extension(path: string) {
  return path.split(".").at(-1)?.toLowerCase() ?? "";
}
