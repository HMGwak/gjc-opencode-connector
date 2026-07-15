import { openCoreDatabase } from "@planee/core";
import { AccessJwtVerifier, type JsonWebKeySet } from "./auth";
import { listenHub } from "./server";

const issuer = process.env.CF_ACCESS_ISSUER;
const audience = process.env.CF_ACCESS_AUDIENCE;
const jwksUrl = process.env.CF_ACCESS_JWKS_URL;
if (!issuer || !audience || !jwksUrl) throw new Error("CF_ACCESS_ISSUER, CF_ACCESS_AUDIENCE, and CF_ACCESS_JWKS_URL are required");

const verifier = new AccessJwtVerifier({
  issuer,
  audience,
  jwks: { async resolve(): Promise<JsonWebKeySet> {
    const response = await fetch(jwksUrl);
    if (!response.ok) throw new Error("JWKS unavailable");
    return await response.json() as JsonWebKeySet;
  } },
});

listenHub({ database: openCoreDatabase(process.env.HUB_DATABASE_PATH), auth: verifier, publicOrigin: process.env.HUB_PUBLIC_ORIGIN });
