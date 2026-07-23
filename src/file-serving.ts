// F05: file browser backend helpers. Borrowed from pi-web's
// app/api/files/[...path]/route.ts — single route dispatched by ?type=, with
// IGNORED_NAMES filtering, dirent/stat fallback for symlinks, EXT_TO_LANGUAGE
// for syntax hinting, size caps, HTTP range for media, streaming body, and an
// SSE `watch` for live preview refresh. Pure node:fs, no native deps.
import fs from "node:fs";
import path from "node:path";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);
const IGNORED_SUFFIXES = [".pyc"];

export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
};

export function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};
const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", weba: "audio/webm",
};

export function getFileExt(filePath: string): string {
  return path.basename(filePath).toLowerCase().split(".").pop() ?? "";
}
export function getImageMime(filePath: string): string | null { return IMAGE_EXT_TO_MIME[getFileExt(filePath)] ?? null; }
export function getAudioMime(filePath: string): string | null { return AUDIO_EXT_TO_MIME[getFileExt(filePath)] ?? null; }
export function isPdfPath(filePath: string): boolean { return getFileExt(filePath) === "pdf"; }

// Dirent.isDirectory()/isFile() can be null on some filesystems / symlinks;
// stat-fallback like pi-web's resolveDirentIsDirectory.
export function resolveDirentIsDirectory(dirent: fs.Dirent, fullPath: string): boolean | null {
  if (dirent.isDirectory()) return true;
  if (dirent.isFile()) return false;
  try { return fs.statSync(fullPath).isDirectory(); } catch { return null; }
}

// allowedRoots = all live session cwds. Browsing/reading is constrained to
// these (prevents `../` escapes reading project-external files). Updated each
// call so newly-created sessions are browsable immediately.
export function allowedRoots(sessions: Iterable<{ cwd: string }>): Set<string> {
  const roots = new Set<string>();
  for (const rt of sessions) {
    try {
      const c = rt.cwd;
      if (c) roots.add(path.resolve(c));
    } catch { /* ignore */ }
  }
  return roots;
}

export function isPathAllowed(target: string, roots: Set<string>): boolean {
  const resolved = path.resolve(target);
  for (const root of roots) {
    // Normalize both to the same separator so mixed / and \ on Windows
    // (front-end sends /, Node path.resolve returns \) doesn't cause false
    // rejections.
    const normRoot = root.replace(/\\/g, "/");
    const normResolved = resolved.replace(/\\/g, "/");
    const rel = path.relative(normRoot, normResolved);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
    if (rel === "") return true; // the root itself
  }
  return false;
}

export { IGNORED_NAMES, IGNORED_SUFFIXES };
