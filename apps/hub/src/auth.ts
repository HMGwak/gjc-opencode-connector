import type { CoreDatabase, DeviceCredential } from "@planee/core";

export type DeviceClaims = {
  readonly sub: string;
  readonly deviceId: string;
};

export type PairingCode = {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: string;
};

export type DeviceRegistration = {
  readonly deviceId: string;
  readonly credential: string;
};

export class DeviceCredentialError extends Error {
  readonly name = "DeviceCredentialError";

  constructor(message = "Device credential rejected") {
    super(message);
  }
}

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const randomId = (): string => crypto.randomUUID();
const randomValue = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));
const pairingCodeLength = 6;
const pairingDigits = 10;
const randomDigitLimit = Math.floor(256 / pairingDigits) * pairingDigits;
const randomPairingCode = (): string => {
  const digits: string[] = [];
  while (digits.length < pairingCodeLength) {
    for (const value of crypto.getRandomValues(new Uint8Array(pairingCodeLength))) {
      if (value >= randomDigitLimit) continue;
      digits.push(String(value % pairingDigits));
      if (digits.length === pairingCodeLength) break;
    }
  }
  return digits.join("");
};

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function pairingHash(secret: Uint8Array, code: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(code))));
}

export class DeviceCredentialVerifier {
  private readonly now: () => number;

  constructor(private readonly options: { readonly database: CoreDatabase; readonly ownerId: string; readonly pairingSecret: Uint8Array; readonly now?: () => number }) {
    if (!options.ownerId || options.pairingSecret.byteLength < 32) throw new TypeError("Device credential verifier requires an owner and a 32-byte pairing secret");
    this.now = options.now ?? Date.now;
  }

  async createPairing(input: { readonly expiresInMs: number; readonly maxAttempts?: number } = { expiresInMs: 300_000 }): Promise<PairingCode> {
    if (!Number.isSafeInteger(input.expiresInMs) || input.expiresInMs < 1 || input.expiresInMs > 900_000) throw new TypeError("Pairing lifetime must be between 1 millisecond and 15 minutes");
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new TypeError("Pairing attempt limit must be between 1 and 10");
    const id = randomId();
    const code = randomPairingCode();
    const expiresAt = new Date(this.now() + input.expiresInMs).toISOString();
    this.options.database.createDevicePairing({ id, ownerId: this.options.ownerId, codeHash: await pairingHash(this.options.pairingSecret, code), expiresAt, maxAttempts });
    this.options.database.writeAudit({ action: "device.pairing.created", payload: { pairingId: id, result: "issued" } });
    return { id, code, expiresAt };
  }

  async redeemPairing(input: { readonly code: string; readonly deviceName: string }): Promise<DeviceRegistration> {
    if (!/^\d{6}$/.test(input.code) || input.deviceName.trim().length === 0 || input.deviceName.length > 80) throw new DeviceCredentialError("Pairing code rejected");
    const pairing = this.options.database.redeemDevicePairing({ codeHash: await pairingHash(this.options.pairingSecret, input.code), at: new Date(this.now()).toISOString() });
    if (!pairing || pairing.ownerId !== this.options.ownerId) throw new DeviceCredentialError("Pairing code rejected");
    const credential = randomValue();
    const device = this.options.database.createDeviceCredential({ id: randomId(), ownerId: pairing.ownerId, deviceName: input.deviceName.trim(), credentialHash: await sha256(credential) });
    this.options.database.writeAudit({ action: "device.pairing.redeemed", payload: { deviceId: device.id, result: "registered" } });
    return { deviceId: device.id, credential };
  }

  async verify(credential: string): Promise<DeviceClaims> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new DeviceCredentialError();
    const device = this.options.database.authenticateDeviceCredential(await sha256(credential), new Date(this.now()).toISOString());
    if (!device) throw new DeviceCredentialError();
    return { sub: device.ownerId, deviceId: device.id };
  }

  listDevices(): readonly DeviceCredential[] {
    return this.options.database.listDeviceCredentials(this.options.ownerId);
  }

  revokeDevice(deviceId: string): boolean {
    const revoked = this.options.database.revokeDeviceCredential(deviceId, new Date(this.now()).toISOString());
    if (revoked) this.options.database.writeAudit({ action: "device.revoked", payload: { deviceId, result: "revoked" } });
    return revoked;
  }
}
