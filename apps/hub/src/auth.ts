export interface AccessClaims {
  readonly sub: string;
  readonly email?: string;
  readonly [claim: string]: unknown;
}

export interface JwksResolver {
  resolve(options?: { readonly bypassCache?: boolean }): Promise<JsonWebKeySet>;
}

export interface AccessJwtOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: JwksResolver;
  readonly clockSkewSeconds?: number;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

export interface AccessJsonWebKey extends JsonWebKey {
  readonly kid?: string;
}

export interface JsonWebKeySet {
  readonly keys: readonly AccessJsonWebKey[];
}

interface JwtHeader { alg: string; kid?: string; }
interface JwtPayload { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; sub?: string; email?: string; [claim: string]: unknown; }

const decode = <T>(part: string): T => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as T;
const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

export class AccessJwtVerifier {
  private cached: JsonWebKeySet | undefined;
  private cacheExpiresAt = 0;
  private refresh: Promise<JsonWebKeySet> | undefined;

  constructor(private readonly options: AccessJwtOptions) {}

  async verify(token: string): Promise<AccessClaims> {
    try {
      const [encodedHeader, encodedPayload, encodedSignature, ...extra] = token.split(".");
      if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length !== 0) throw new Error("Malformed JWT");
      const header = decode<JwtHeader>(encodedHeader);
      const payload = decode<JwtPayload>(encodedPayload);
      if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported JWT");
      const keySet = await this.keys();
      let key = keySet.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
      if (!key) key = (await this.keys(true)).keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
      if (!key) throw new Error("Unknown signing key");
      const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, fromBase64Url(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
      if (!valid) throw new Error("Invalid signature");
      const now = (this.options.now ?? Date.now)() / 1000;
      const skew = this.options.clockSkewSeconds ?? 60;
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (payload.iss !== this.options.issuer || !audience.includes(this.options.audience) || typeof payload.exp !== "number" || payload.exp <= now - skew || (typeof payload.nbf === "number" && payload.nbf > now + skew) || typeof payload.sub !== "string") throw new Error("Invalid claims");
      return payload as AccessClaims;
    } catch {
      throw new Error("Access JWT rejected");
    }
  }

  private async keys(bypassCache = false): Promise<JsonWebKeySet> {
    const now = (this.options.now ?? Date.now)();
    if (!bypassCache && this.cached && now < this.cacheExpiresAt) return this.cached;
    if (this.refresh) return this.refresh;
    this.refresh = this.options.jwks.resolve({ bypassCache }).then((resolved) => {
      if (!Array.isArray(resolved.keys) || resolved.keys.length === 0) throw new Error("JWKS unavailable");
      this.cached = resolved;
      this.cacheExpiresAt = (this.options.now ?? Date.now)() + (this.options.cacheTtlMs ?? 300_000);
      return resolved;
    }).finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
}
