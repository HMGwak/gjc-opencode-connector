import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHubWebHandler } from "./web";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("Hub web handler", () => {
  test("serves the built application while delegating API requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "planee-hub-web-"));
    roots.push(root);
    await Bun.write(join(root, "index.html"), "<main>Pair this device</main>");
    const handler = createHubWebHandler({
      api: { fetch: async () => new Response("unauthorized", { status: 401 }) },
      webRoot: root,
    });

    const page = await handler.fetch(new Request("https://agents.example/"));
    const api = await handler.fetch(new Request("https://agents.example/api/v1/sessions"));

    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<main>Pair this device</main>");
    expect(page.headers.get("content-type")).toStartWith("text/html");
    expect(api.status).toBe(401);
  });

  test("does not serve paths outside the built application", async () => {
    const root = await mkdtemp(join(tmpdir(), "planee-hub-web-"));
    roots.push(root);
    await Bun.write(join(root, "index.html"), "ok");
    const handler = createHubWebHandler({ api: { fetch: async () => new Response("api") }, webRoot: root });

    expect((await handler.fetch(new Request("https://agents.example/%2e%2e/secret"))).status).toBe(404);
  });
});
