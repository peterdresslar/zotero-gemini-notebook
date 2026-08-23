export function getSingleSelectedCollection(zoteroPane) {
  if (typeof zoteroPane?.getSelectedCollections === "function") {
    const collections = zoteroPane.getSelectedCollections();
    return Array.isArray(collections) && collections.length === 1
      ? collections[0]
      : undefined;
  }

  if (typeof zoteroPane?.getSelectedCollection === "function") {
    return zoteroPane.getSelectedCollection();
  }

  return undefined;
}
