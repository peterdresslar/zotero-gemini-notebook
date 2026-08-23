import assert from "node:assert/strict";
import test from "node:test";

import { getSingleSelectedCollection } from "../src/modules/selectedCollection.js";

test("uses the Zotero 10 plural collection selection API", () => {
  const collection = { id: 10, name: "Zotero 10" };
  let singularCalled = false;
  const selected = getSingleSelectedCollection({
    getSelectedCollections: () => [collection],
    getSelectedCollection: () => {
      singularCalled = true;
      throw new Error("Removed in Zotero 10");
    },
  });

  assert.equal(selected, collection);
  assert.equal(singularCalled, false);
});

test("does not arbitrarily preselect one of several Zotero 10 collections", () => {
  assert.equal(
    getSingleSelectedCollection({
      getSelectedCollections: () => [
        { id: 10, name: "First" },
        { id: 11, name: "Second" },
      ],
    }),
    undefined,
  );
});

test("falls back to the singular collection API in Zotero 7 through 9", () => {
  const collection = { id: 9, name: "Zotero 9" };
  assert.equal(
    getSingleSelectedCollection({
      getSelectedCollection: () => collection,
    }),
    collection,
  );
});

test("handles an empty or unavailable collection selection", () => {
  assert.equal(
    getSingleSelectedCollection({ getSelectedCollections: () => [] }),
    undefined,
  );
  assert.equal(getSingleSelectedCollection({}), undefined);
  assert.equal(getSingleSelectedCollection(null), undefined);
});
