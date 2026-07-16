import { stat } from "node:fs/promises";

export async function readPairingSecret(path: string): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (metadata.uid !== 0 || (metadata.mode & 0o077) !== 0) throw new Error("HUB_PAIRING_ROOT_SECRET_FILE must be root-owned with mode 0600");
  const secret = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (secret.byteLength !== 32) throw new Error("HUB_PAIRING_ROOT_SECRET_FILE must contain exactly 32 bytes");
  return secret;
}
