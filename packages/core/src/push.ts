import { createHash } from "node:crypto";
import { CoreDatabase } from "./database";
import type { PushPayload, PushSubscription } from "./types";

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
  readonly expirationTime?: string | null;
}

export interface PushMaterial {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

/** Supplies the VAPID private key at send time; it must never be persisted. */
export interface VapidSecretProvider {
  getVapidPrivateKey(): string | Uint8Array;
}

/** Encrypts subscription material before persistence and decrypts only for delivery. */
export interface PushMaterialCipher {
  encrypt(material: PushMaterial): string;
  decrypt(ciphertext: string): PushMaterial;
}

/** The transport owns VAPID signing and is the only recipient of decrypted material. */
export interface PushProvider {
  send(input: { readonly subscription: PushMaterial; readonly payload: PushPayload; readonly vapidPrivateKey: string | Uint8Array }): Promise<void>;
}

export interface PushServiceOptions {
  readonly database: CoreDatabase;
  readonly cipher: PushMaterialCipher;
  readonly provider: PushProvider;
  readonly vapidSecretProvider: VapidSecretProvider;
  readonly appOrigin: string;
  readonly allowedDeepLinkPaths: readonly string[];
  readonly now?: () => Date;
}

export class PushValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushValidationError";
  }
}

const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex");
const isGone = (error: unknown): boolean => typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 410;

export class PushService {
  private readonly now: () => Date;
  private readonly origin: URL;

  constructor(private readonly options: PushServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.origin = new URL(options.appOrigin);
    if (this.origin.protocol !== "https:") throw new PushValidationError("Push app origin must use HTTPS");
    if (!options.allowedDeepLinkPaths.length || options.allowedDeepLinkPaths.some((path) => !path.startsWith("/"))) {
      throw new PushValidationError("At least one absolute deep-link allowlist path is required");
    }
  }

  subscribe(ownerId: string, input: PushSubscriptionInput): PushSubscription {
    if (!ownerId) throw new PushValidationError("Push subscription owner is required");
    this.validateSubscription(input);
    const hash = endpointHash(input.endpoint);
    const encryptedMaterial = this.options.cipher.encrypt({ endpoint: input.endpoint, keys: input.keys });
    if (!encryptedMaterial) throw new PushValidationError("Push material cipher returned empty ciphertext");
    const subscription = this.options.database.upsertPushSubscription({ ownerId, endpointHash: hash, encryptedMaterial, expiresAt: input.expirationTime ?? null });
    this.options.database.writeAudit({ action: "push.subscription.upserted", payload: { ownerId, endpointHash: hash } });
    return subscription;
  }

  revoke(ownerId: string, endpoint: string): boolean {
    if (!ownerId) throw new PushValidationError("Push subscription owner is required");
    const hash = endpointHash(endpoint);
    const revoked = this.options.database.revokePushSubscription(ownerId, hash);
    if (revoked) this.options.database.writeAudit({ action: "push.subscription.revoked", payload: { ownerId, endpointHash: hash } });
    return revoked;
  }

  async notify(ownerId: string, payload: PushPayload): Promise<{ readonly sent: number; readonly removed: number }> {
    if (!ownerId) throw new PushValidationError("Push subscription owner is required");
    const minimized = this.validatePayload(payload);
    const at = this.now().toISOString();
    let removed = this.options.database.deleteExpiredPushSubscriptions(at);
    let sent = 0;
    for (const stored of this.options.database.listPushSubscriptions(ownerId, at)) {
      try {
        const subscription = this.options.cipher.decrypt(stored.encryptedMaterial);
        await this.options.provider.send({ subscription, payload: minimized, vapidPrivateKey: this.options.vapidSecretProvider.getVapidPrivateKey() });
        sent++;
      } catch (error) {
        if (isGone(error) && this.options.database.revokePushSubscription(ownerId, stored.endpointHash)) {
          removed++;
          this.options.database.writeAudit({ action: "push.subscription.expired", payload: { ownerId, endpointHash: stored.endpointHash } });
        }
      }
    }
    return { sent, removed };
  }

  private validateSubscription(input: PushSubscriptionInput): void {
    let endpoint: URL;
    try { endpoint = new URL(input.endpoint); } catch { throw new PushValidationError("Push endpoint must be a valid HTTPS URL"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !input.keys?.p256dh || !input.keys?.auth) {
      throw new PushValidationError("Push subscription is invalid");
    }
    if (input.expirationTime !== undefined && input.expirationTime !== null && (!Number.isFinite(Date.parse(input.expirationTime)) || Date.parse(input.expirationTime) <= this.now().getTime())) {
      throw new PushValidationError("Push subscription expiration must be in the future");
    }
  }

  private validatePayload(payload: PushPayload): PushPayload {
    if (payload === null || typeof payload !== "object") throw new PushValidationError("Push payload must be an object");
    const keys = Object.keys(payload);
    if (keys.some((key) => key !== "title" && key !== "body" && key !== "deepLink")) throw new PushValidationError("Push payload contains unsupported fields");
    if (payload.title !== undefined && (typeof payload.title !== "string" || payload.title.length > 120)) throw new PushValidationError("Push title is invalid");
    if (payload.body !== undefined && (typeof payload.body !== "string" || payload.body.length > 500)) throw new PushValidationError("Push body is invalid");
    const result: { title?: string; body?: string; deepLink?: string } = {};
    if (payload.title) result.title = payload.title;
    if (payload.body) result.body = payload.body;
    if (payload.deepLink !== undefined) result.deepLink = this.validateDeepLink(payload.deepLink);
    if (!result.title && !result.body && !result.deepLink) throw new PushValidationError("Push payload must contain a visible hint or deep link");
    return result;
  }

  private validateDeepLink(value: string): string {
    if (typeof value !== "string") throw new PushValidationError("Push deep link is invalid");
    let link: URL;
    try { link = new URL(value, this.origin); } catch { throw new PushValidationError("Push deep link is invalid"); }
    if (link.origin !== this.origin.origin || link.username || link.password || link.search || link.hash || !this.options.allowedDeepLinkPaths.some((path) => link.pathname === path || link.pathname.startsWith(`${path}/`))) {
      throw new PushValidationError("Push deep link is not allowlisted");
    }
    return link.pathname;
  }
}

export const hashPushEndpoint = endpointHash;
