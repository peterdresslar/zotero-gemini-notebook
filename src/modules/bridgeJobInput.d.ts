interface NormalizedBridgeJobBase {
  libraryID: number;
  destination: "active-or-new";
  requestId?: string;
  replace: boolean;
  studioPrompt?: string;
}

export const MAX_STUDIO_PROMPT_BYTES: 4000;
export function normalizeStudioPrompt(value: unknown): string | undefined;

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
