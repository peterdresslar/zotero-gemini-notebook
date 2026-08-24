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

export const PRIVATE_RESPONSE_OPTIONS = Object.freeze({
  logFilter: () => "[Zotero Gemini Notebook response omitted]",
});
