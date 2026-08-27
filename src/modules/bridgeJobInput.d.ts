interface NormalizedBridgeJobBase {
  libraryID: number;
  destination: "active-or-new";
  requestId?: string;
  replace: boolean;
}

export interface NormalizedBridgeJobFromItems extends NormalizedBridgeJobBase {
  readonly itemKeys: readonly string[];
}

export interface NormalizedBridgeJobFromCollection extends NormalizedBridgeJobBase {
  collectionKey: string;
  recursive: boolean;
}

export type NormalizedCreateBridgeJobInput =
  | NormalizedBridgeJobFromItems
  | NormalizedBridgeJobFromCollection;

export function normalizeCreateBridgeJobInput(
  input: unknown,
): NormalizedCreateBridgeJobInput;
