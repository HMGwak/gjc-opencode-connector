import { afterEach, describe, expect, test } from "bun:test";
import { CoreDatabase, SecretDataError } from "./database";
import { PushService, type PushMaterial, type PushMaterialCipher, type PushProvider } from "./push";

const databases: CoreDatabase[] = [];
const database = (): CoreDatabase => { const value = new CoreDatabase(); databases.push(value); return value; };
afterEach(() => { while (databases.length) databases.pop()!.close(); });

const cipher: PushMaterialCipher = {
  encrypt: (material) => `cipher:${Buffer.from(JSON.stringify(material)).toString("base64url")}`,
  decrypt: (ciphertext) => JSON.parse(Buffer.from(ciphertext.slice("cipher:".length), "base64url").toString()) as PushMaterial,
};
const input = (endpoint = "https://push.example.test/subscription-one") => ({ endpoint, keys: { p256dh: "public-key", auth: "auth-secret" } });
const service = (db: CoreDatabase, provider: PushProvider, instant = "2030-01-01T00:00:00.000Z") => new PushService({
  database: db,
  cipher,
  provider,
  vapidSecretProvider: { getVapidPrivateKey: () => "vapid-private-key" },
  appOrigin: "https://app.example.test",
  allowedDeepLinkPaths: ["/sessions", "/actions"],
  now: () => new Date(instant),
});

describe("PushService", () => {
  test("upserts a rotated subscription without duplicating its endpoint", () => {
    const db = database();
    const push = service(db, { send: async () => {} });
    const first = push.subscribe("owner-a", input());
    const rotated = push.subscribe("owner-a", { ...input(), keys: { p256dh: "rotated-key", auth: "rotated-auth" } });
    expect(rotated.endpointHash).toBe(first.endpointHash);
    expect(db.listPushSubscriptions("owner-a")).toHaveLength(1);
    expect(db.listPushSubscriptions("owner-a")[0]!.encryptedMaterial).not.toContain("rotated-auth");
  });

  test("binds endpoints to their owner and revocation cannot cross owner boundaries", () => {
    const db = database();
    const push = service(db, { send: async () => {} });
    push.subscribe("owner-a", input());
    expect(() => push.subscribe("owner-b", input())).toThrow("belongs to another owner");
    expect(push.revoke("owner-b", input().endpoint)).toBeFalse();
    expect(db.listPushSubscriptions("owner-a")).toHaveLength(1);
    expect(push.revoke("owner-a", input().endpoint)).toBeTrue();
    expect(db.listPushSubscriptions("owner-a")).toHaveLength(0);
  });

  test("removes expired subscriptions and provider 410 endpoints", async () => {
    const db = database();
    const failure = Object.assign(new Error("gone"), { status: 410 });
    const push = service(db, { send: async () => { throw failure; } });
    push.subscribe("owner-a", input("https://push.example.test/gone"));
    db.upsertPushSubscription({ ownerId: "owner-a", endpointHash: "a".repeat(64), encryptedMaterial: "cipher:expired", expiresAt: "2029-12-31T23:59:59.000Z" });
    await expect(push.notify("owner-a", { title: "Updated", deepLink: "/sessions/1" })).resolves.toEqual({ sent: 0, removed: 2 });
    expect(db.listPushSubscriptions("owner-a")).toHaveLength(0);
  });

  test("sends only minimized payloads to the provider", async () => {
    const db = database();
    const sent: unknown[] = [];
    const push = service(db, { send: async (request) => { sent.push(request); } });
    push.subscribe("owner-a", input());
    await push.notify("owner-a", { title: "Updated", body: "One action needs attention", deepLink: "https://app.example.test/actions/7" });
    expect(sent).toEqual([{ subscription: { endpoint: input().endpoint, keys: input().keys }, payload: { title: "Updated", body: "One action needs attention", deepLink: "/actions/7" }, vapidPrivateKey: "vapid-private-key" }]);
    await expect(push.notify("owner-a", { title: "Updated", secret: "no" } as never)).rejects.toThrow("unsupported fields");
    await expect(push.notify("owner-a", { title: "Updated", deepLink: "https://other.example.test/actions/7" })).rejects.toThrow("not allowlisted");
  });

  test("writes audit records without endpoint, key, auth, or VAPID material", () => {
    const db = database();
    const push = service(db, { send: async () => {} });
    push.subscribe("owner-a", input());
    push.revoke("owner-a", input().endpoint);
    const audit = db.sqlite.query("SELECT payload_json FROM audit_log ORDER BY id").all() as Array<{ payload_json: string }>;
    expect(JSON.stringify(audit)).not.toContain(input().endpoint);
    expect(JSON.stringify(audit)).not.toContain("auth-secret");
    expect(JSON.stringify(audit)).not.toContain("vapid-private-key");
    expect(() => db.writeAudit({ action: "push.bad", payload: { auth: "auth-secret" } })).toThrow(SecretDataError);
  });
});
