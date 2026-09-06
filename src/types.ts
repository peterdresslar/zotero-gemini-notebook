export interface StagedItem {
  itemId: number;
  title: string;
  creators: string;
  year: string;
  attachmentId: number;
  contentType: string;
  fileName: string;
}

export interface CollectionNode {
  id: number;
  name: string;
  level: number;
  parentId: number | null;
  children: CollectionNode[];
  itemCount: number;
}

export interface ItemRow {
  id: number;
  title: string;
  creators: string;
  year: string;
  hasValidAttachment: boolean;
  attachmentId: number | null;
  contentType: string | null;
  fileName: string | null;
}

export type BridgeJobState =
  | "staged"
  | "claimed"
  | "submitted"
  | "verifying"
  | "verified"
  | "unverified"
  | "failed"
  | "cancelled"
  | "expired"
  | "superseded";

export type ChromeUploadDestination = "new" | "active-or-new";

interface CreateBridgeJobBase {
  libraryID: number;
  destination: "active-or-new";
  requestId?: string;
  replace?: boolean;
  studioPrompt?: string;
}

export interface CreateBridgeJobFromItemsInput extends CreateBridgeJobBase {
  itemKeys: string[];
  collectionKey?: never;
  recursive?: never;
}

export interface CreateBridgeJobFromCollectionInput extends CreateBridgeJobBase {
  collectionKey: string;
  recursive?: boolean;
  itemKeys?: never;
}

export type CreateBridgeJobInput =
  | CreateBridgeJobFromItemsInput
  | CreateBridgeJobFromCollectionInput;

export interface PendingResponse {
  items: StagedItem[];
  count: number;
  timestamp: number | null;
  compatibleChromeExtensionVersions: string[];
  jobId: string | null;
  destination: ChromeUploadDestination | null;
  studioPrompt?: string;
}

export interface StatusResponse {
  ready: boolean;
  count: number;
  zoteroVersion: string;
  pluginVersion: string;
  mcpOptedIn: boolean;
}

export interface FileResponse {
  data: string;
  contentType: string;
  fileName: string;
}
