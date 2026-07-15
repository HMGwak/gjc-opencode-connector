import { expect, test } from "bun:test";

const sourcePath = new URL("./subscriptions.ts", import.meta.url);

test("SubscriptionHub keeps network-facing operations outside mutex callbacks", async () => {
  const source = await Bun.file(sourcePath).text();
  expect(source).not.toMatch(/withMutex\(\(\) => \{[^}]*\.(?:send|replay)\(/s);
  expect(source).not.toMatch(/withMutex\(\(\) => \{[^}]*\bawait\b/s);
  expect(source).toContain("await this.source.replay");
  expect(source).toContain("await listener.send(event)");
});

test("sender construction and gate transition each have one production site", async () => {
  const source = await Bun.file(sourcePath).text();
  expect(source.match(/void this\.sender\(listener\)/g)).toHaveLength(1);
  expect(source.match(/listener\.gate = "OPEN"/g)).toHaveLength(1);
  expect(source).toContain('if (!listener.disconnected) {\n          listener.gate = "OPEN";');
});
