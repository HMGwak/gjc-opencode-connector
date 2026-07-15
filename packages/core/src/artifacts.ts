import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";

const DEFAULT_MIME_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export class ArtifactError extends Error {
  constructor(readonly code: "invalid" | "expired" | "not-found" | "forbidden" | "unsupported-media" | "too-large" | "timeout" | "invalid-range", message: string) {
    super(message);
  }
}

export interface ArtifactFile {
  readonly stat: () => Promise<{ readonly isFile: () => boolean; readonly size: number; readonly dev: number; readonly ino: number }>;
  readonly readFile: () => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
}
export interface ArtifactIo {
  readonly stat?: (path: string) => Promise<{ readonly isFile: () => boolean; readonly size: number; readonly dev: number; readonly ino: number }>;
  readonly open?: (path: string) => Promise<ArtifactFile>;
}

export interface ArtifactServiceOptions {
  readonly workdirs: readonly string[];
  readonly secret: string | Uint8Array;
  readonly mimeTypes?: Readonly<Record<string, string>>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly expiresInMs?: number;
  readonly now?: () => number;
  readonly io?: ArtifactIo;
}

export interface ArtifactRange { readonly start: number; readonly end: number; }
export interface ArtifactRead {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  readonly size: number;
  readonly range: ArtifactRange;
}

interface StoredArtifact { readonly path: string; readonly expiresAt: number; }
interface ArtifactToken { readonly id: string; readonly exp: number; readonly v: 1; }

const base64url = (value: Uint8Array | string): string => Buffer.from(value).toString("base64url");
const decodeBase64url = (value: string): Uint8Array => Buffer.from(value, "base64url");
const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

export function parseByteRange(header: string | null, size: number, maxBytes: number): ArtifactRange {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size <= 0) throw new ArtifactError("invalid-range", "Invalid byte range");
  const [, startText, endText] = match;
  if (!startText && !endText) throw new ArtifactError("invalid-range", "Invalid byte range");
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ArtifactError("invalid-range", "Invalid byte range");
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(startText); end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw new ArtifactError("invalid-range", "Invalid byte range");
    end = Math.min(end, size - 1);
  }
  if (end - start + 1 > maxBytes) throw new ArtifactError("invalid-range", "Requested range is too large");
  return { start, end };
}

export class ArtifactService {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private constructor(private readonly roots: readonly string[], private readonly options: Required<Pick<ArtifactServiceOptions, "maxBytes" | "timeoutMs" | "expiresInMs" | "now" | "mimeTypes">> & Pick<ArtifactServiceOptions, "secret">, private readonly io: Required<ArtifactIo>) {}

  static async create(options: ArtifactServiceOptions): Promise<ArtifactService> {
    if (!options.workdirs.length) throw new Error("At least one artifact workdir is required");
    const roots = await Promise.all(options.workdirs.map((workdir) => realpath(workdir)));
    return new ArtifactService(roots, { secret: options.secret, mimeTypes: options.mimeTypes ?? DEFAULT_MIME_TYPES, maxBytes: options.maxBytes ?? 10 * 1024 * 1024, timeoutMs: options.timeoutMs ?? 5_000, expiresInMs: options.expiresInMs ?? 60 * 60 * 1000, now: options.now ?? Date.now }, { stat: options.io?.stat ?? stat, open: options.io?.open ?? ((path) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)) });
  }

  async issue(path: string): Promise<string> {
    const target = await this.safePath(path);
    const info = await this.statFile(target);
    if (!info.isFile()) throw new ArtifactError("not-found", "Artifact is not a file");
    this.mimeType(target);
    if (info.size > this.options.maxBytes) throw new ArtifactError("too-large", "Artifact exceeds maximum size");
    const id = base64url(randomBytes(24));
    const exp = this.options.now() + this.options.expiresInMs;
    this.artifacts.set(id, { path: target, expiresAt: exp });
    return this.sign({ id, exp, v: 1 });
  }

  async read(token: string, rangeHeader: string | null = null): Promise<ArtifactRead> {
    const tokenData = this.verify(token);
    const stored = this.artifacts.get(tokenData.id);
    if (!stored || stored.expiresAt !== tokenData.exp) throw new ArtifactError("not-found", "Artifact not found");
    if (tokenData.exp <= this.options.now()) { this.artifacts.delete(tokenData.id); throw new ArtifactError("expired", "Artifact expired"); }
    const target = await this.safePath(stored.path);
    const mimeType = this.mimeType(target);
    let file: ArtifactFile | undefined;
    try {
      file = await this.openFile(target);
      const info = await this.statOpenedFile(file);
      if (!info.isFile()) throw new ArtifactError("not-found", "Artifact is not a file");
      if (info.size > this.options.maxBytes) throw new ArtifactError("too-large", "Artifact exceeds maximum size");
      const currentPath = await this.safePath(target);
      const current = await this.statFile(currentPath);
      if (info.dev !== current.dev || info.ino !== current.ino) throw new ArtifactError("not-found", "Artifact changed while being read");
      const range = parseByteRange(rangeHeader, info.size, this.options.maxBytes);
      const readOperation = file.readFile();
      let raw: Uint8Array;
      try {
        raw = await this.withTimeout(readOperation);
      } catch (error) {
        if (error instanceof ArtifactError && error.code === "timeout") {
          const pendingFile = file;
          file = undefined;
          void readOperation.finally(() => pendingFile.close()).catch(() => undefined);
        }
        throw error;
      }
      const bytes = new Uint8Array(raw.subarray(range.start, range.end + 1));
      return { bytes, mimeType, filename: basename(target), size: info.size, range };
    } finally {
      if (file) await file.close();
    }
  }

  private async safePath(path: string): Promise<string> {
    let target: string;
    try {
      target = await realpath(path);
      const roots = this.roots;
      if (!roots.some((root) => isInside(root, target))) throw new ArtifactError("forbidden", "Artifact path is outside configured workdirs");
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("not-found", "Artifact not found");
    }
    return target;
  }

  private async statFile(path: string): Promise<{ readonly isFile: () => boolean; readonly size: number; readonly dev: number; readonly ino: number }> {
    try { return await this.withTimeout(this.io.stat(path)); }
    catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("not-found", "Artifact not found");
    }
  }

  private async openFile(path: string): Promise<ArtifactFile> {
    try { return await this.withTimeout(this.io.open(path)); }
    catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("not-found", "Artifact not found");
    }
  }

  private async statOpenedFile(file: ArtifactFile): Promise<{ readonly isFile: () => boolean; readonly size: number; readonly dev: number; readonly ino: number }> {
    try { return await this.withTimeout(file.stat()); }
    catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("not-found", "Artifact not found");
    }
  }
  private mimeType(path: string): string {
    const mimeType = this.options.mimeTypes[extname(path).toLowerCase()];
    if (!mimeType) throw new ArtifactError("unsupported-media", "Artifact media type is not allowed");
    return mimeType;
  }

  private sign(value: ArtifactToken): string {
    const payload = base64url(JSON.stringify(value));
    const signature = createHmac("sha256", this.options.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify(token: string): ArtifactToken {
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) throw new ArtifactError("invalid", "Invalid artifact ID");
    const expected = createHmac("sha256", this.options.secret).update(parts[0]!).digest();
    const actual = Buffer.from(parts[1]!, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ArtifactError("invalid", "Invalid artifact ID");
    try {
      const value = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0]!))) as ArtifactToken;
      if (value.v !== 1 || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(value.id) || !Number.isSafeInteger(value.exp)) throw new Error();
      return value;
    } catch { throw new ArtifactError("invalid", "Invalid artifact ID"); }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ArtifactError("timeout", "Artifact operation timed out")), this.options.timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

export const createArtifactService = ArtifactService.create;
