import { isAbsolute, relative, resolve } from "node:path";

type HubHandler = {
  readonly fetch: (request: Request) => Promise<Response>;
};

type WebHandlerOptions = {
  readonly api: HubHandler;
  readonly webRoot: string;
};

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const contentType = (path: string): string => {
  const extension = path.slice(path.lastIndexOf("."));
  return contentTypes[extension] ?? "application/octet-stream";
};

const filePath = (root: string, pathname: string): string | undefined => {
  if (pathname.includes("%")) return undefined;
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(root, relativePath);
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot)) ? candidate : undefined;
};

const notFound = (): Response => new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });

export function createHubWebHandler(options: WebHandlerOptions): HubHandler {
  const root = resolve(options.webRoot);
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/v1/")) return options.api.fetch(request);
      if (request.method !== "GET" && request.method !== "HEAD") return notFound();
      const path = filePath(root, url.pathname);
      if (!path) return notFound();
      const file = Bun.file(path);
      if (!await file.exists()) return notFound();
      const headers = new Headers({
        "cache-control": path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        "content-type": contentType(path),
        "x-content-type-options": "nosniff",
      });
      return new Response(request.method === "HEAD" ? null : file, { headers });
    },
  };
}
