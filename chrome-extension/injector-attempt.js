(() => {
  "use strict";

  const ATTEMPT_NONCE_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const NOTEBOOK_PATH_PATTERN = /^\/notebook\/[A-Za-z0-9_-]{1,256}$/u;
  const CURRENT_NOTEBOOK_PATH_PATTERN =
    /^\/notebook\/[A-Za-z0-9_-]{1,256}\/?$/u;
  const NOTEBOOK_HOSTS = new Set([
    "notebook.google.com",
    "notebooklm.google.com",
  ]);
  const ATTEMPT_MISMATCH_ERROR =
    "The prepared Gemini Notebook changed before Zotero could add the files.";
  const INJECTOR_FAILURE_ERROR =
    "Gemini Notebook could not accept the staged files.";

  function createUploadAttempt(notebookPathname, randomUUID) {
    if (
      (notebookPathname !== null &&
        notebookPathname !== undefined &&
        readCanonicalNotebookPathname(notebookPathname) === null) ||
      typeof randomUUID !== "function"
    ) {
      throw new TypeError("Upload attempt binding is invalid");
    }
    const attemptNonce = readAttemptNonce(randomUUID());
    if (!attemptNonce) {
      throw new TypeError("Upload attempt nonce is invalid");
    }
    return freezeBinding(attemptNonce, notebookPathname ?? null);
  }

  function readBinding(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const attemptNonce = readAttemptNonce(value.attemptNonce);
    const notebookPathname =
      value.notebookPathname === null
        ? null
        : readCanonicalNotebookPathname(value.notebookPathname);
    return attemptNonce &&
      Object.hasOwn(value, "notebookPathname") &&
      (notebookPathname !== null || value.notebookPathname === null)
      ? freezeBinding(attemptNonce, notebookPathname)
      : null;
  }

  function createController(options = {}) {
    const getCurrentUrl = options.getCurrentUrl;
    if (typeof getCurrentUrl !== "function") {
      throw new TypeError("Attempt controller options are invalid");
    }
    let binding = null;

    function arm(value) {
      const candidate = readBinding(value);
      if (binding) return null;
      if (
        !candidate ||
        (candidate.notebookPathname !== null &&
          canonicalNotebookPathname(getCurrentUrl()) !==
            candidate.notebookPathname)
      ) {
        return null;
      }
      binding = candidate;
      return binding;
    }

    function check(attemptNonce) {
      const current = binding;
      const requestedAttemptNonce =
        attemptNonce === null || attemptNonce === undefined
          ? null
          : readAttemptNonce(attemptNonce);
      const nonceMatches = Boolean(
        current && current.attemptNonce === requestedAttemptNonce,
      );
      const pathnameMatches =
        current?.notebookPathname === null ||
        canonicalNotebookPathname(getCurrentUrl()) ===
          current?.notebookPathname;
      return Object.freeze({
        attemptNonce: requestedAttemptNonce,
        currentAttempt: nonceMatches,
        ok: Boolean(current && nonceMatches && pathnameMatches),
      });
    }

    function matches(attemptNonce) {
      return Boolean(
        binding && binding.attemptNonce === (attemptNonce ?? null),
      );
    }

    function clear() {
      binding = null;
    }

    function getBinding() {
      return binding;
    }

    return Object.freeze({ arm, check, clear, getBinding, matches });
  }

  function matchesResponse(binding, response) {
    return Boolean(
      binding &&
      response &&
      typeof response === "object" &&
      response.attemptNonce === binding.attemptNonce,
    );
  }

  function canonicalNotebookPathname(value) {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        !NOTEBOOK_HOSTS.has(parsed.hostname) ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        !CURRENT_NOTEBOOK_PATH_PATTERN.test(parsed.pathname)
      ) {
        return null;
      }
      return parsed.pathname.endsWith("/")
        ? parsed.pathname.slice(0, -1)
        : parsed.pathname;
    } catch {
      return null;
    }
  }

  function readCanonicalNotebookPathname(value) {
    return typeof value === "string" && NOTEBOOK_PATH_PATTERN.test(value)
      ? value
      : null;
  }

  function readAttemptNonce(value) {
    return typeof value === "string" && ATTEMPT_NONCE_PATTERN.test(value)
      ? value
      : null;
  }

  function freezeBinding(attemptNonce, notebookPathname) {
    return Object.freeze({ attemptNonce, notebookPathname });
  }

  globalThis.ZoteroInjectorAttempt = Object.freeze({
    ATTEMPT_MISMATCH_ERROR,
    INJECTOR_FAILURE_ERROR,
    canonicalNotebookPathname,
    createController,
    createUploadAttempt,
    matchesResponse,
    readAttemptNonce,
    readBinding,
    readCanonicalNotebookPathname,
  });
})();
