export type PushApi = (path: string, init?: RequestInit) => Promise<Response>;

type PushKeyResponse = { publicKey?: unknown };

const pushOptions = (publicKey: string): PushSubscriptionOptionsInit => ({
  userVisibleOnly: true,
  applicationServerKey: base64UrlToBytes(publicKey),
});

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid push public key");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function publicKey(api: PushApi): Promise<string> {
  const response = await api("/push/public-key", { cache: "no-store" });
  if (!response.ok) throw new Error(`push public key request failed (${response.status})`);
  const body = await response.json() as PushKeyResponse;
  if (typeof body.publicKey !== "string" || body.publicKey.length === 0) throw new Error("Invalid push public key");
  return body.publicKey;
}

export async function enablePush(api: PushApi): Promise<NotificationPermission> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) throw new Error("Push notifications are unavailable");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    await revokePush(api);
    return permission;
  }
  const registration = await navigator.serviceWorker.ready;
  const previous = await registration.pushManager.getSubscription();
  const subscription = await registration.pushManager.subscribe(pushOptions(await publicKey(api)));
  try {
    const response = await api("/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`push subscription request failed (${response.status})`);
    if (previous && previous.endpoint !== subscription.endpoint) await previous.unsubscribe();
    return permission;
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }
}

export async function revokePush(api: PushApi): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const response = await api("/push/subscriptions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
    cache: "no-store",
  });
  if (!response.ok && response.status !== 404) throw new Error(`push revocation request failed (${response.status})`);
  await subscription.unsubscribe();
}

export async function revokePushWhenPermissionLost(api: PushApi): Promise<void> {
  if ("Notification" in window && Notification.permission !== "granted") await revokePush(api);
}
