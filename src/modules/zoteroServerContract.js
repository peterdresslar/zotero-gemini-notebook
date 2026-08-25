export const ZOTERO_MUTATION_METHOD = "POST";

export function createStatusResponse({
  ready,
  count,
  zoteroVersion,
  pluginVersion,
  mcpOptedIn,
}) {
  return Object.freeze({
    ready,
    count,
    zoteroVersion,
    pluginVersion,
    mcpOptedIn: mcpOptedIn === true,
  });
}

export function readPendingDestination(activeJob) {
  const destination = activeJob?.destination;
  return destination === "new" || destination === "active-or-new"
    ? destination
    : null;
}

export const PRIVATE_RESPONSE_OPTIONS = Object.freeze({
  logFilter: () => "[Zotero Gemini Notebook response omitted]",
});
