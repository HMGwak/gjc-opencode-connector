import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactError, createArtifactService, parseByteRange } from "./artifacts";

const fixtures: string[] = [];
const fixture = async (): Promise<{ root: string; outside: string }> => {
  const base = await mkdtemp(join(tmpdir(), "core-artifacts-")); fixtures.push(base);
  const root = join(base, "work"); const outside = join(base, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(join(root, "report.txt"), "0123456789");
  await writeFile(join(outside, "secret.txt"), "outside");
  return { root, outside };
};
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const code = (value: unknown): string => (value as ArtifactError).code;
const rejectionCode = async (operation: Promise<unknown>): Promise<string> => {
  try { await operation; throw new Error("Expected operation to reject"); } catch (error) { return code(error); }
};

describe("ArtifactService", () => {
  test("issues opaque signed IDs and reads a valid byte range", async () => {
    const { root } = await fixture(); const service = await createArtifactService({ workdirs: [root], secret: "test-secret" });
    const id = await service.issue(join(root, "report.txt"));
    expect(id).not.toContain("report"); expect(id.split(".")).toHaveLength(2);
    const artifact = await service.read(id, "bytes=2-5");
    expect(new TextDecoder().decode(artifact.bytes)).toBe("2345"); expect(artifact.range).toEqual({ start: 2, end: 5 });
    expect(await rejectionCode(service.read(`${id}x`))).toBe("invalid");
  });
  test("accepts artifact tokens before expiry and rejects them at and after expiry", async () => {
    const { root } = await fixture();
    let now = 1_000;
    const service = await createArtifactService({ workdirs: [root], secret: "test-secret", expiresInMs: 10, now: () => now });
    const before = await service.issue(join(root, "report.txt"));
    now = 1_009;
    expect(new TextDecoder().decode((await service.read(before)).bytes)).toBe("0123456789");

    const at = await service.issue(join(root, "report.txt"));
    now = 1_019;
    expect(await rejectionCode(service.read(at))).toBe("expired");

    const after = await service.issue(join(root, "report.txt"));
    now = 1_030;
    expect(await rejectionCode(service.read(after))).toBe("expired");
  });

  test("rejects traversal, encoded traversal, and symlink escapes", async () => {
    const { root, outside } = await fixture(); const service = await createArtifactService({ workdirs: [root], secret: "test-secret" });
    expect(await rejectionCode(service.issue(join(root, "..", "outside", "secret.txt")))).toBe("forbidden");
    expect(await rejectionCode(service.issue(join(root, "%2e%2e", "outside", "secret.txt")))).toBe("not-found");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    expect(await rejectionCode(service.issue(join(root, "escape.txt")))).toBe("forbidden");
  });

  test("rejects disallowed media types and oversized files", async () => {
    const { root } = await fixture(); await writeFile(join(root, "program.exe"), "x"); await writeFile(join(root, "large.txt"), "0123456789");
    const service = await createArtifactService({ workdirs: [root], secret: "test-secret", maxBytes: 5 });
    expect(await rejectionCode(service.issue(join(root, "program.exe")))).toBe("unsupported-media");
    expect(await rejectionCode(service.issue(join(root, "large.txt")))).toBe("too-large");
  });

  test("supports suffix and open-ended ranges and rejects zero-byte ranges", () => {
    expect(parseByteRange("bytes=-3", 10, 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange("bytes=7-", 10, 10)).toEqual({ start: 7, end: 9 });
    expect(() => parseByteRange("bytes=0-0", 0, 10)).toThrow(ArtifactError);
  });

  test("rejects invalid and multi-ranges", () => {
    expect(() => parseByteRange("bytes=0-1,3-4", 10, 10)).toThrow(ArtifactError);
    expect(() => parseByteRange("bytes=10-12", 10, 10)).toThrow(ArtifactError);
    expect(() => parseByteRange("bytes=0-9", 10, 5)).toThrow(ArtifactError);
  });

  test("times out a slow artifact read", async () => {
    const { root } = await fixture();
    const service = await createArtifactService({
      workdirs: [root],
      secret: "test-secret",
      timeoutMs: 1,
      io: {
        open: async (path) => {
          const file = await open(path);
          return { stat: () => file.stat(), readFile: async () => await new Promise<Uint8Array>((resolve) => setTimeout(async () => resolve(await file.readFile()), 20)), close: () => file.close() };
        },
      },
    });
    const id = await service.issue(join(root, "report.txt"));
    expect(await rejectionCode(service.read(id))).toBe("timeout");
  });
  test("rejects a symlink swap after opening an artifact", async () => {
    const { root, outside } = await fixture();
    let swapOnOpen = false;
    const service = await createArtifactService({
      workdirs: [root],
      secret: "test-secret",
      io: {
        open: async (path) => {
          const file = await open(path);
          if (swapOnOpen) {
            await rename(path, `${path}.original`);
            await symlink(join(outside, "secret.txt"), path);
          }
          return { stat: () => file.stat(), readFile: () => file.readFile(), close: () => file.close() };
        },
      },
    });
    const id = await service.issue(join(root, "report.txt"));
    swapOnOpen = true;
    expect(await rejectionCode(service.read(id))).toBe("forbidden");
  });

  test("rejects reads after configured root replacement", async () => {
    const { root, outside } = await fixture();
    const service = await createArtifactService({ workdirs: [root], secret: "test-secret" });
    await writeFile(join(outside, "report.txt"), "replacement");
    const id = await service.issue(join(root, "report.txt"));
    await rename(root, `${root}-original`);
    await symlink(outside, root);
    expect(await rejectionCode(service.read(id))).toBe("forbidden");
  });
});
