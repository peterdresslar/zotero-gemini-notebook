import assert from "node:assert/strict";
import test from "node:test";

import "../chrome-extension/source-verification.js";

const { evaluateSourceVerification, normalizeTitle } =
  globalThis.ZoteroSourceVerification;

const NOTEBOOK_ID = "01234567-89ab-4cde-8fab-0123456789ab";

function observation(overrides = {}) {
  return {
    baselineNotebookId: NOTEBOOK_ID,
    baselineRows: [],
    createdNewNotebook: true,
    currentNotebookId: NOTEBOOK_ID,
    currentRows: [ready("alpha.pdf"), ready("beta.pdf")],
    expectedNames: ["alpha.pdf", "beta.pdf"],
    layoutRecognized: true,
    stableObservations: 2,
    ...overrides,
  };
}

function ready(title) {
  return { state: "ready", title };
}

test("matches only an exact stable visible-ready source multiset", () => {
  assert.deepEqual(evaluateSourceVerification(observation()), {
    status: "matched",
    reason: "visible_ready_match",
  });
  assert.deepEqual(
    evaluateSourceVerification(
      observation({
        currentRows: [ready("beta.pdf"), ready("alpha.pdf")],
      }),
    ),
    { status: "matched", reason: "visible_ready_match" },
  );
});

test("normalizes only Unicode composition and whitespace", () => {
  assert.equal(
    normalizeTitle("  Re\u0301sume\u0301   2026.PDF  "),
    "Résumé 2026.PDF",
  );
  assert.notEqual(normalizeTitle("Alpha.PDF"), normalizeTitle("alpha.pdf"));
  assert.notEqual(normalizeTitle("alpha.pdf"), normalizeTitle("alpha"));
});

test("requires an explicitly new, initially empty, unchanged notebook", () => {
  for (const [overrides, expected] of [
    [
      { createdNewNotebook: false },
      { status: "unsupported", reason: "destination_not_new" },
    ],
    [
      { baselineRows: [ready("existing.pdf")] },
      { status: "ambiguous", reason: "nonempty_baseline" },
    ],
    [
      { currentNotebookId: "another-notebook" },
      { status: "ambiguous", reason: "notebook_changed" },
    ],
  ]) {
    assert.deepEqual(
      evaluateSourceVerification(observation(overrides)),
      expected,
    );
  }
});

test("fails closed for duplicates, renamed sources, and concurrent extras", () => {
  for (const [overrides, reason] of [
    [
      {
        expectedNames: ["same.pdf", "same.pdf"],
        currentRows: [ready("same.pdf"), ready("same.pdf")],
      },
      "duplicate_expected_names",
    ],
    [
      { currentRows: [ready("alpha"), ready("beta.pdf")] },
      "source_names_changed",
    ],
    [
      {
        currentRows: [
          ready("alpha.pdf"),
          ready("beta.pdf"),
          ready("manual.pdf"),
        ],
      },
      "unexpected_sources",
    ],
  ]) {
    assert.equal(
      evaluateSourceVerification(observation(overrides)).reason,
      reason,
    );
  }
});

test("never matches partial, loading, error, or unstable observations", () => {
  for (const [overrides, reason] of [
    [{ currentRows: [ready("alpha.pdf")] }, "sources_missing"],
    [
      {
        currentRows: [
          ready("alpha.pdf"),
          { state: "loading", title: "beta.pdf" },
        ],
      },
      "sources_not_ready",
    ],
    [
      {
        currentRows: [
          ready("alpha.pdf"),
          { state: "error", title: "beta.pdf" },
        ],
      },
      "source_error",
    ],
    [{ stableObservations: 1 }, "observation_not_stable"],
  ]) {
    const result = evaluateSourceVerification(observation(overrides));
    assert.equal(result.status, "incomplete");
    assert.equal(result.reason, reason);
  }
});

test("treats unknown layouts and malformed observations as unsupported", () => {
  for (const input of [
    observation({ layoutRecognized: false }),
    observation({ currentRows: [{ state: "mystery", title: "alpha.pdf" }] }),
    observation({ expectedNames: [] }),
    observation({ stableObservations: 1.5 }),
    null,
  ]) {
    assert.equal(evaluateSourceVerification(input).status, "unsupported");
  }
});

test("does not emit or retain private evidence outside the fixed result", () => {
  const sentinel = "PRIVATE-SOURCE-TITLE-DO-NOT-LEAK.pdf";
  const result = evaluateSourceVerification(
    observation({
      currentRows: [ready(sentinel)],
      expectedNames: [sentinel],
    }),
  );

  assert.deepEqual(result, {
    status: "matched",
    reason: "visible_ready_match",
  });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});
