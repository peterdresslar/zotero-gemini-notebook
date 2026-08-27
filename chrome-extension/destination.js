(() => {
  "use strict";

  const PREPARE_DESTINATION_ACTION = "prepareUploadDestination";
  const DESTINATION_NEW = "new";
  const DESTINATION_ACTIVE_OR_NEW = "active-or-new";
  const DESTINATIONS = new Set([DESTINATION_NEW, DESTINATION_ACTIVE_OR_NEW]);
  const NOTEBOOK_HOSTS = new Set([
    "notebook.google.com",
    "notebooklm.google.com",
  ]);
  const NOTEBOOK_PATH_PATTERN = /^\/notebook\/[A-Za-z0-9_-]{1,256}\/?$/u;
  const OPEN_HOME_GUIDANCE =
    "This Zotero import requires a new notebook. Open Gemini Notebook home, then try again.";
  const OPEN_GEMINI_GUIDANCE =
    "Open Gemini Notebook home or a notebook, then try the import again.";
  const PREPARATION_FAILED_GUIDANCE =
    "Gemini Notebook could not prepare the import destination. Open Gemini Notebook home, then try again.";
  const PREPARED_NOTEBOOK_MISSING =
    "Gemini Notebook did not open the prepared notebook.";
  const FIXED_PREPARATION_ERRORS = new Set([
    OPEN_HOME_GUIDANCE,
    OPEN_GEMINI_GUIDANCE,
    PREPARATION_FAILED_GUIDANCE,
    PREPARED_NOTEBOOK_MISSING,
  ]);

  function readDestination(value) {
    return DESTINATIONS.has(value) ? value : null;
  }

  function canonicalNotebookPathname(value) {
    const parsed = parseGeminiNotebookUrl(value);
    if (!parsed || !NOTEBOOK_PATH_PATTERN.test(parsed.pathname)) return null;
    return parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  }

  function readCanonicalNotebookPathname(value) {
    if (
      typeof value !== "string" ||
      !NOTEBOOK_PATH_PATTERN.test(value) ||
      value.endsWith("/")
    ) {
      return null;
    }
    return value;
  }

  function isGeminiNotebookHome(value) {
    const parsed = parseGeminiNotebookUrl(value);
    return Boolean(parsed && parsed.pathname === "/");
  }

  function isDestinationBoundToUrl(binding, value) {
    return Boolean(
      readDestinationBinding(
        binding?.destination,
        binding?.notebookPathname,
        binding?.createdNewNotebook,
      ) && canonicalNotebookPathname(value) === binding.notebookPathname,
    );
  }

  function readDestinationBinding(
    destinationValue,
    notebookPathnameValue,
    createdNewNotebook,
  ) {
    const destination = readDestination(destinationValue);
    const notebookPathname = readCanonicalNotebookPathname(
      notebookPathnameValue,
    );
    if (
      !destination ||
      !notebookPathname ||
      typeof createdNewNotebook !== "boolean" ||
      (destination === DESTINATION_NEW && createdNewNotebook !== true)
    ) {
      return null;
    }
    return freezeBinding(destination, notebookPathname, createdNewNotebook);
  }

  async function prepareBrowserDestination(options = {}) {
    const destination = readDestination(options.destination);
    const getCurrentUrl = options.getCurrentUrl;
    const createNotebook = options.createNotebook;
    if (
      !destination ||
      typeof getCurrentUrl !== "function" ||
      typeof createNotebook !== "function"
    ) {
      throw new TypeError("Upload destination preparation is invalid");
    }

    let notebookPathname = canonicalNotebookPathname(getCurrentUrl());
    if (notebookPathname) {
      if (destination === DESTINATION_NEW) {
        throw new Error(OPEN_HOME_GUIDANCE);
      }
      return freezeBinding(destination, notebookPathname, false);
    }

    if (!isGeminiNotebookHome(getCurrentUrl())) {
      throw new Error(
        destination === DESTINATION_NEW
          ? OPEN_HOME_GUIDANCE
          : OPEN_GEMINI_GUIDANCE,
      );
    }

    const createdNewNotebook = await createNotebook();
    if (createdNewNotebook !== true) {
      throw new Error(PREPARED_NOTEBOOK_MISSING);
    }
    notebookPathname = canonicalNotebookPathname(getCurrentUrl());
    if (!notebookPathname) {
      throw new Error(PREPARED_NOTEBOOK_MISSING);
    }
    return freezeBinding(destination, notebookPathname, createdNewNotebook);
  }

  async function requestPreparedDestination(options = {}) {
    if (options.jobId === null || options.jobId === undefined) return null;
    const destination = readDestination(options.destination);
    if (!destination) {
      throw new Error(
        "Zotero did not provide a supported destination for this staged import.",
      );
    }
    if (typeof options.sendMessage !== "function") {
      throw new TypeError("Destination message sender is unavailable");
    }

    let response;
    try {
      response = await options.sendMessage({
        action: PREPARE_DESTINATION_ACTION,
        destination,
      });
    } catch {
      throw new Error(PREPARATION_FAILED_GUIDANCE);
    }
    if (!response?.success) {
      throw new Error(readPreparationError(response?.error));
    }
    const binding = readDestinationBinding(
      response.destination,
      response.notebookPathname,
      response.createdNewNotebook,
    );
    if (!binding || binding.destination !== destination) {
      throw new Error(
        "Gemini Notebook returned an invalid import destination.",
      );
    }
    return binding;
  }

  function readPreparationError(value) {
    return FIXED_PREPARATION_ERRORS.has(value)
      ? value
      : PREPARATION_FAILED_GUIDANCE;
  }

  function freezeBinding(destination, notebookPathname, createdNewNotebook) {
    return Object.freeze({
      createdNewNotebook,
      destination,
      notebookPathname,
    });
  }

  function parseGeminiNotebookUrl(value) {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        !NOTEBOOK_HOSTS.has(parsed.hostname) ||
        parsed.port ||
        parsed.username ||
        parsed.password
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  globalThis.ZoteroUploadDestination = Object.freeze({
    DESTINATION_ACTIVE_OR_NEW,
    DESTINATION_NEW,
    OPEN_HOME_GUIDANCE,
    PREPARATION_FAILED_GUIDANCE,
    PREPARE_DESTINATION_ACTION,
    canonicalNotebookPathname,
    isDestinationBoundToUrl,
    isGeminiNotebookHome,
    prepareBrowserDestination,
    readCanonicalNotebookPathname,
    readDestination,
    readDestinationBinding,
    readPreparationError,
    requestPreparedDestination,
  });
})();
