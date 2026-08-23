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

interface CreateBridgeJobBase {
  libraryID: number;
  destination: "new";
  requestId?: string;
  replace?: boolean;
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
}

export interface StatusResponse {
  ready: boolean;
  count: number;
  zoteroVersion: string;
  pluginVersion: string;
}

export interface FileResponse {
  data: string;
  contentType: string;
  fileName: string;
}
