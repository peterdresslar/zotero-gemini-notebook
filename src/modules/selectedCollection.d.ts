export interface SelectedCollection {
  id: number;
  name: string;
}

export interface CollectionSelectionPane {
  getSelectedCollections?: () => SelectedCollection[];
  getSelectedCollection?: () => SelectedCollection | undefined;
}

export function getSingleSelectedCollection(
  zoteroPane: CollectionSelectionPane | null | undefined,
): SelectedCollection | undefined;
