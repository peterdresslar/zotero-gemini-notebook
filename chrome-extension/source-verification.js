(() => {
  "use strict";

  // This pure comparator describes only a point-in-time visible UI match. It
  // deliberately does not claim byte identity, successful indexing, or a
  // durable Gemini Notebook state, and it performs no lifecycle mutation.
  const SOURCE_ROW_STATES = new Set(["ready", "loading", "error", "unknown"]);
  const VERIFICATION_STATUSES = Object.freeze({
    MATCHED: "matched",
    INCOMPLETE: "incomplete",
    AMBIGUOUS: "ambiguous",
    UNSUPPORTED: "unsupported",
  });

  function evaluateSourceVerification(input) {
    if (!isPlainObject(input)) {
      return result("unsupported", "invalid_observation");
    }

    const expectedNames = normalizeNames(input.expectedNames);
    const baselineRows = normalizeRows(input.baselineRows);
    const currentRows = normalizeRows(input.currentRows);
    if (!expectedNames || !baselineRows || !currentRows) {
      return result("unsupported", "invalid_observation");
    }
    if (input.layoutRecognized !== true) {
      return result("unsupported", "unknown_layout");
    }
    if (input.createdNewNotebook !== true) {
      return result("unsupported", "destination_not_new");
    }
    if (
      typeof input.baselineNotebookId !== "string" ||
      input.baselineNotebookId.length === 0 ||
      input.currentNotebookId !== input.baselineNotebookId
    ) {
      return result("ambiguous", "notebook_changed");
    }
    if (!Number.isSafeInteger(input.stableObservations)) {
      return result("unsupported", "invalid_observation");
    }
    if (expectedNames.length === 0) {
      return result("unsupported", "empty_expectation");
    }
    if (new Set(expectedNames).size !== expectedNames.length) {
      return result("ambiguous", "duplicate_expected_names");
    }
    if (baselineRows.length !== 0) {
      return result("ambiguous", "nonempty_baseline");
    }
    if (currentRows.some((row) => row.state === "error")) {
      return result("incomplete", "source_error");
    }
    if (currentRows.some((row) => row.state !== "ready")) {
      return result("incomplete", "sources_not_ready");
    }

    const observedNames = currentRows.map((row) => row.title);
    if (observedNames.length < expectedNames.length) {
      return result("incomplete", "sources_missing");
    }
    if (observedNames.length > expectedNames.length) {
      return result("ambiguous", "unexpected_sources");
    }
    if (!sameMultiset(observedNames, expectedNames)) {
      return result("ambiguous", "source_names_changed");
    }
    if (input.stableObservations < 2) {
      return result("incomplete", "observation_not_stable");
    }

    return result("matched", "visible_ready_match");
  }

  function normalizeNames(value) {
    if (!Array.isArray(value)) return null;
    const names = [];
    for (const item of value) {
      const name = normalizeTitle(item);
      if (!name) return null;
      names.push(name);
    }
    return names;
  }

  function normalizeRows(value) {
    if (!Array.isArray(value)) return null;
    const rows = [];
    for (const item of value) {
      if (!isPlainObject(item) || !SOURCE_ROW_STATES.has(item.state)) {
        return null;
      }
      const title = normalizeTitle(item.title);
      if (!title) return null;
      rows.push(Object.freeze({ state: item.state, title }));
    }
    return rows;
  }

  function normalizeTitle(value) {
    if (typeof value !== "string") return "";
    return value.normalize("NFC").replace(/\s+/gu, " ").trim();
  }

  function sameMultiset(left, right) {
    const counts = new Map();
    for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
    for (const value of right) {
      const count = counts.get(value) ?? 0;
      if (count === 0) return false;
      if (count === 1) counts.delete(value);
      else counts.set(value, count - 1);
    }
    return counts.size === 0;
  }

  function result(status, reason) {
    return Object.freeze({ status, reason });
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  globalThis.ZoteroSourceVerification = Object.freeze({
    VERIFICATION_STATUSES,
    evaluateSourceVerification,
    normalizeTitle,
  });
})();
