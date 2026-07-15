export interface ControlPlaneContractSource {
  readonly url: string;
  readonly kind: "official" | "local-probe";
}

export interface ControlPlaneContract {
  readonly status: "verified" | "partial" | "deferred";
  readonly sources: readonly ControlPlaneContractSource[];
  readonly expectations: Readonly<Record<string, unknown>>;
}

export interface ControlPlaneManifest {
  readonly generatedAt: string;
  readonly contracts: Readonly<Record<string, ControlPlaneContract>>;
}
