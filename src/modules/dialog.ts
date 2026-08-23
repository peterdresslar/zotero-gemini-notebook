import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { getLibraries, getCollectionTree, flattenTree } from "./collections";
import { getItemsForCollection, searchItems } from "./items";
import { stageItems } from "./staging";
import { showStagingSuccess } from "./stagingAction";
import type { CollectionNode, ItemRow, StagedItem } from "../types";

let dialogWindow: Window | null = null;

export function openExportDialog(parentWin: Window) {
  if (isWindowAlive(dialogWindow ?? undefined)) {
    dialogWindow!.focus();
    return;
  }

  dialogWindow = parentWin.openDialog(
    `chrome://${config.addonRef}/content/notebooklm-dialog.xhtml`,
    "notebooklm-export",
    "chrome,centerscreen,resizable=yes",
  );

  // Wait for the dialog window to load before initializing
  const win = dialogWindow;
  win!.addEventListener("load", () => {
    initDialog(win!);
  });
}

interface DialogState {
  win: Window;
  doc: Document;
  libraryID: number;
  selectedCollectionId: number | null;
  flatCollections: CollectionNode[];
  items: ItemRow[];
  selectedItemIds: Set<number>;
  sortKey: ItemSortKey;
  sortDirection: SortDirection;
  searchTimeout: number | null;
}

type ItemSortKey = "title" | "creators" | "year" | "type";
type SortDirection = "asc" | "desc";

const SORT_LABELS: Record<ItemSortKey, string> = {
  title: "Title",
  creators: "Creators",
  year: "Year",
  type: "Type",
};

async function initDialog(win: Window) {
  const doc = win.document;

  try {
    Zotero.debug("[NotebookLM] Dialog init starting...");

    const libraries = getLibraries();
    Zotero.debug(`[NotebookLM] Found ${libraries.length} libraries`);

    const libraryID =
      libraries.length > 0 ? libraries[0].id : Zotero.Libraries.userLibraryID;
    Zotero.debug(`[NotebookLM] Using library ID: ${libraryID}`);

    const state: DialogState = {
      win,
      doc,
      libraryID,
      selectedCollectionId: null,
      flatCollections: [],
      items: [],
      selectedItemIds: new Set(),
      sortKey: "title",
      sortDirection: "asc",
      searchTimeout: null,
    };

    // Load collection tree
    const tree = await getCollectionTree(libraryID);
    Zotero.debug(`[NotebookLM] Got ${tree.length} top-level collections`);
    state.flatCollections = flattenTree(tree);
    Zotero.debug(
      `[NotebookLM] Flattened to ${state.flatCollections.length} total collections`,
    );
    renderCollectionList(state);

    // Pre-select current collection if user has one selected in main pane
    try {
      const zoteroPane = Zotero.getActiveZoteroPane();
      const currentCollection = zoteroPane.getSelectedCollection();
      if (currentCollection) {
        Zotero.debug(
          `[NotebookLM] Pre-selecting collection: ${currentCollection.name}`,
        );
        await selectCollection(state, currentCollection.id);
      }
    } catch {
      // No collection selected, that's fine
    }

    // Wire up search
    const searchInput = doc.getElementById(
      "notebooklm-search-input",
    ) as HTMLInputElement;
    searchInput.addEventListener("input", () => {
      if (state.searchTimeout) {
        win.clearTimeout(state.searchTimeout);
      }
      state.searchTimeout = win.setTimeout(async () => {
        const query = searchInput.value.trim();
        if (query) {
          state.selectedCollectionId = null;
          highlightCollection(state, null);
          state.items = await searchItems(state.libraryID, query);
        } else if (state.selectedCollectionId) {
          state.items = await getItemsForCollection(state.selectedCollectionId);
        } else {
          state.items = [];
        }
        sortItems(state);
        state.selectedItemIds.clear();
        renderItemList(state);
        updateBottomBar(state);
      }, 300) as unknown as number;
    });

    // Wire up item-list controls
    wireItemControls(state);
    updateItemControls(state);

    // Wire up export button
    const exportBtn = doc.getElementById("notebooklm-export-btn")!;
    exportBtn.addEventListener("command", () => doExport(state));

    // Wire up cancel button
    const cancelBtn = doc.getElementById("notebooklm-cancel-btn")!;
    cancelBtn.addEventListener("command", () => win.close());

    Zotero.debug("[NotebookLM] Dialog init complete");
  } catch (e: any) {
    Zotero.debug(`[NotebookLM] Dialog init ERROR: ${e.message}\n${e.stack}`);
  }
}

function renderCollectionList(state: DialogState) {
  const container = state.doc.getElementById("notebooklm-collection-list")!;
  container.innerHTML = "";

  if (state.flatCollections.length === 0) {
    const msg = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    msg.className = "empty-message";
    msg.textContent = "No collections found";
    container.appendChild(msg);
    return;
  }

  for (const col of state.flatCollections) {
    const div = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    div.className = "collection-item";
    div.dataset.collectionId = String(col.id);
    div.style.paddingLeft = `${8 + col.level * 16}px`;

    const nameSpan = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    );
    nameSpan.textContent = col.name;
    div.appendChild(nameSpan);

    const countSpan = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    );
    countSpan.className = "item-count";
    countSpan.textContent = `(${col.itemCount})`;
    div.appendChild(countSpan);

    div.addEventListener("click", () => selectCollection(state, col.id));
    container.appendChild(div);
  }
}

async function selectCollection(state: DialogState, collectionId: number) {
  state.selectedCollectionId = collectionId;
  state.selectedItemIds.clear();

  // Clear search
  const searchInput = state.doc.getElementById(
    "notebooklm-search-input",
  ) as HTMLInputElement;
  searchInput.value = "";

  highlightCollection(state, collectionId);

  state.items = await getItemsForCollection(collectionId);
  sortItems(state);
  renderItemList(state);
  updateBottomBar(state);
}

function highlightCollection(state: DialogState, collectionId: number | null) {
  const container = state.doc.getElementById("notebooklm-collection-list")!;
  for (const el of Array.from(container.querySelectorAll(".collection-item"))) {
    const htmlEl = el as HTMLElement;
    if (
      collectionId !== null &&
      htmlEl.dataset.collectionId === String(collectionId)
    ) {
      htmlEl.classList.add("selected");
      htmlEl.scrollIntoView({ block: "nearest" });
    } else {
      htmlEl.classList.remove("selected");
    }
  }
}

function wireItemControls(state: DialogState) {
  const selectAllCheckbox = state.doc.getElementById(
    "notebooklm-select-all-checkbox",
  ) as HTMLInputElement | null;
  selectAllCheckbox?.addEventListener("change", () => {
    setAllVisibleItemsSelected(state, selectAllCheckbox.checked);
    renderItemList(state);
    updateBottomBar(state);
  });

  for (const button of Array.from(
    state.doc.querySelectorAll("[data-sort-key]"),
  )) {
    const htmlButton = button as HTMLElement;
    const sortKey = htmlButton.dataset.sortKey as ItemSortKey | undefined;
    if (!sortKey) continue;

    htmlButton.addEventListener("click", () => {
      setItemSort(state, sortKey);
    });
  }
}

function renderItemList(state: DialogState) {
  const container = state.doc.getElementById("notebooklm-item-list")!;
  container.innerHTML = "";
  updateItemControls(state);

  if (state.items.length === 0) {
    const msg = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    msg.className = "empty-message";
    msg.textContent = state.selectedCollectionId
      ? "No items in this collection"
      : "Select a collection or search to view items";
    container.appendChild(msg);
    return;
  }

  for (const item of state.items) {
    const row = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    row.className = `item-row${item.hasValidAttachment ? "" : " disabled"}`;

    // Checkbox (display-only — pointer-events disabled, row click handles toggle)
    const checkbox = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "input",
    ) as HTMLInputElement;
    checkbox.type = "checkbox";
    checkbox.disabled = !item.hasValidAttachment;
    checkbox.checked = state.selectedItemIds.has(item.id);
    checkbox.style.pointerEvents = "none";
    row.appendChild(checkbox);

    // Title
    const titleDiv = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    titleDiv.className = "item-title";
    titleDiv.textContent = item.title;
    titleDiv.title = item.title;
    row.appendChild(titleDiv);

    // Creators
    const creatorsDiv = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    creatorsDiv.className = "item-creators";
    creatorsDiv.textContent = item.creators;
    creatorsDiv.title = item.creators;
    row.appendChild(creatorsDiv);

    // Year
    const yearDiv = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    yearDiv.className = "item-year";
    yearDiv.textContent = item.year;
    row.appendChild(yearDiv);

    // File type badge
    const typeBadge = state.doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    typeBadge.className = "item-type-badge";
    typeBadge.textContent = item.hasValidAttachment
      ? getTypeLabel(item.contentType!)
      : "---";
    row.appendChild(typeBadge);

    // Click anywhere on the row to toggle (if enabled)
    if (item.hasValidAttachment) {
      row.addEventListener("click", () => {
        toggleItem(state, item.id, checkbox);
      });
    }

    container.appendChild(row);
  }
}

function toggleItem(
  state: DialogState,
  itemId: number,
  checkbox: HTMLInputElement,
) {
  if (state.selectedItemIds.has(itemId)) {
    state.selectedItemIds.delete(itemId);
    checkbox.checked = false;
  } else {
    state.selectedItemIds.add(itemId);
    checkbox.checked = true;
  }
  updateBottomBar(state);
}

function setAllVisibleItemsSelected(state: DialogState, selected: boolean) {
  for (const item of state.items) {
    if (!item.hasValidAttachment) continue;
    if (selected) {
      state.selectedItemIds.add(item.id);
    } else {
      state.selectedItemIds.delete(item.id);
    }
  }
}

function setItemSort(state: DialogState, sortKey: ItemSortKey) {
  if (state.sortKey === sortKey) {
    state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = sortKey;
    state.sortDirection = "asc";
  }

  sortItems(state);
  renderItemList(state);
  updateBottomBar(state);
}

function sortItems(state: DialogState) {
  const direction = state.sortDirection === "asc" ? 1 : -1;
  state.items.sort((a, b) => {
    const attachmentComparison = compareAttachmentAvailability(a, b);
    if (attachmentComparison !== 0) return attachmentComparison;

    const valueComparison = compareItemSortValues(a, b, state.sortKey);
    if (valueComparison !== 0) return valueComparison * direction;

    return a.title.localeCompare(b.title, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function compareAttachmentAvailability(a: ItemRow, b: ItemRow) {
  if (a.hasValidAttachment === b.hasValidAttachment) return 0;
  return a.hasValidAttachment ? -1 : 1;
}

function compareItemSortValues(a: ItemRow, b: ItemRow, sortKey: ItemSortKey) {
  if (sortKey === "year") {
    return compareYears(a.year, b.year);
  }

  return getSortValue(a, sortKey).localeCompare(
    getSortValue(b, sortKey),
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
}

function compareYears(a: string, b: string) {
  const aYear = Number.parseInt(a, 10);
  const bYear = Number.parseInt(b, 10);
  const aHasYear = !Number.isNaN(aYear);
  const bHasYear = !Number.isNaN(bYear);

  if (aHasYear && bHasYear && aYear !== bYear) return aYear - bYear;
  if (aHasYear !== bHasYear) return aHasYear ? -1 : 1;
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function getSortValue(item: ItemRow, sortKey: ItemSortKey) {
  switch (sortKey) {
    case "title":
      return item.title;
    case "creators":
      return item.creators;
    case "type":
      return getItemTypeLabel(item);
    case "year":
      return item.year;
  }
}

function getItemTypeLabel(item: ItemRow) {
  return item.hasValidAttachment && item.contentType
    ? getTypeLabel(item.contentType)
    : "";
}

function updateItemControls(state: DialogState) {
  updateSelectAllCheckbox(state);
  updateSortButtons(state);
}

function updateSelectAllCheckbox(state: DialogState) {
  const checkbox = state.doc.getElementById(
    "notebooklm-select-all-checkbox",
  ) as HTMLInputElement | null;
  if (!checkbox) return;

  const selectableCount = state.items.filter(
    (item) => item.hasValidAttachment,
  ).length;
  const selectedCount = state.items.filter(
    (item) => item.hasValidAttachment && state.selectedItemIds.has(item.id),
  ).length;

  checkbox.disabled = selectableCount === 0;
  checkbox.checked = selectableCount > 0 && selectedCount === selectableCount;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < selectableCount;
  checkbox.title = checkbox.checked
    ? "Deselect all items with supported attachments"
    : "Select all items with supported attachments";
}

function updateSortButtons(state: DialogState) {
  for (const button of Array.from(
    state.doc.querySelectorAll("[data-sort-key]"),
  )) {
    const htmlButton = button as HTMLButtonElement;
    const sortKey = htmlButton.dataset.sortKey as ItemSortKey | undefined;
    if (!sortKey) continue;

    const isActive = sortKey === state.sortKey;
    htmlButton.classList.toggle("active", isActive);
    htmlButton.setAttribute("aria-pressed", String(isActive));
    htmlButton.textContent =
      SORT_LABELS[sortKey] +
      (isActive ? (state.sortDirection === "asc" ? " ▲" : " ▼") : "");
  }
}

function getTypeLabel(contentType: string): string {
  if (contentType.includes("pdf")) return "PDF";
  if (contentType.includes("wordprocessing")) return "DOCX";
  if (contentType.includes("markdown")) return "MD";
  if (contentType.includes("plain")) return "TXT";
  return "FILE";
}

function updateBottomBar(state: DialogState) {
  updateItemControls(state);

  const countLabel = state.doc.getElementById("notebooklm-selected-count")!;
  const exportBtn = state.doc.getElementById("notebooklm-export-btn")!;

  const count = state.selectedItemIds.size;
  countLabel.setAttribute(
    "value",
    `${count} item${count === 1 ? "" : "s"} selected`,
  );
  exportBtn.setAttribute("disabled", String(count === 0));
}

async function doExport(state: DialogState) {
  const exportBtn = state.doc.getElementById("notebooklm-export-btn")!;

  // Disable button and show progress
  exportBtn.setAttribute("disabled", "true");
  exportBtn.setAttribute("label", "Exporting...");

  // Small delay to let any pending checkbox state settle
  await new Promise((resolve) => state.win.setTimeout(resolve, 150));

  // Re-read selected items from current state (captures all clicks)
  const selectedItems: StagedItem[] = [];
  for (const item of state.items) {
    if (
      state.selectedItemIds.has(item.id) &&
      item.hasValidAttachment &&
      item.attachmentId !== null &&
      item.fileName !== null &&
      item.contentType !== null
    ) {
      selectedItems.push({
        itemId: item.id,
        title: item.title,
        creators: item.creators,
        year: item.year,
        attachmentId: item.attachmentId,
        contentType: item.contentType,
        fileName: item.fileName,
      });
    }
  }

  stageItems(selectedItems, { source: "export-dialog" });
  state.win.close();
  showStagingSuccess(selectedItems.length);
}
