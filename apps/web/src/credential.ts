type SecureCredentialPlugin = {
  get(): Promise<{ readonly credential?: unknown }>;
  set(input: { readonly credential: string }): Promise<void>;
  clear(): Promise<void>;
};

declare global {
  interface Window {
    readonly Capacitor?: {
      readonly Plugins?: {
        readonly SecureCredential?: SecureCredentialPlugin;
      };
    };
  }
}

export class SecureCredentialUnavailableError extends Error {
  readonly name = "SecureCredentialUnavailableError";

  constructor() {
    super("Secure Android storage is unavailable");
  }
}

const plugin = (): SecureCredentialPlugin => {
  const value = window.Capacitor?.Plugins?.SecureCredential;
  if (!value) throw new SecureCredentialUnavailableError();
  return value;
};

export async function storedCredential(): Promise<string | null> {
  const value = await plugin().get();
  return typeof value.credential === "string" ? value.credential : null;
}

export async function saveCredential(credential: string): Promise<void> {
  await plugin().set({ credential });
}

export async function clearCredential(): Promise<void> {
  await plugin().clear();
}
