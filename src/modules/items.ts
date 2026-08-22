import type { ItemRow, StagedItem } from "../types";
import { getValidAttachment } from "../utils/attachment";

export async function toStagedItem(
  item: Zotero.Item,
): Promise<StagedItem | null> {
  if (!item.isRegularItem()) return null;

  const attachment = await getValidAttachment(item);
  if (!attachment) return null;

  return {
    itemId: item.id,
    title: (item.getField("title") as string) || "(Untitled)",
    creators: formatCreators(item),
    year: (item.getField("year") as string) || "",
    attachmentId: attachment.attachmentId,
    contentType: attachment.contentType,
    fileName: attachment.fileName,
  };
}

export async function getItemsForCollection(
  collectionId: number,
): Promise<ItemRow[]> {
  const collection = Zotero.Collections.get(collectionId);
  if (!collection) return [];

  const items = collection.getChildItems();
  return enrichItems(items);
}

export async function searchItems(
  libraryID: number,
  query: string,
): Promise<ItemRow[]> {
  if (!query.trim()) return [];

  const s = new Zotero.Search();
  (s as any).libraryID = libraryID;
  s.addCondition("quicksearch-titleCreatorYear", "contains", query);
  const ids = await s.search();
  if (!ids.length) return [];

  const items = await Zotero.Items.getAsync(ids);
  // Filter out attachments and notes — we only want regular items
  const regularItems = items.filter((item: Zotero.Item) =>
    item.isRegularItem(),
  );
  return enrichItems(regularItems);
}

async function enrichItems(items: Zotero.Item[]): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  for (const item of items) {
    if (!item.isRegularItem()) continue;

    const attachment = await getValidAttachment(item);
    rows.push({
      id: item.id,
      title: (item.getField("title") as string) || "(Untitled)",
      creators: formatCreators(item),
      year: (item.getField("year") as string) || "",
      hasValidAttachment: attachment !== null,
      attachmentId: attachment?.attachmentId ?? null,
      contentType: attachment?.contentType ?? null,
      fileName: attachment?.fileName ?? null,
    });
  }

  // Sort: items with attachments first, then alphabetically by title
  rows.sort((a, b) => {
    if (a.hasValidAttachment !== b.hasValidAttachment) {
      return a.hasValidAttachment ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });

  return rows;
}

function formatCreators(item: Zotero.Item): string {
  const creators = item.getCreators();
  if (!creators || creators.length === 0) return "";

  const names = creators.map(
    (c: any) => c.lastName || c.name || c.firstName || "",
  );
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}
