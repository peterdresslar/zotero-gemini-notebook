import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import "../chrome-extension/destination.js";

const {
  OPEN_HOME_GUIDANCE,
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
} = globalThis.ZoteroUploadDestination;

const popupSource = await readFile(
  new globalThis.URL("../chrome-extension/popup.js", import.meta.url),
  "utf8",
);
const contentSource = await readFile(
  new globalThis.URL("../chrome-extension/content.js", import.meta.url),
  "utf8",
);
const popupHTML = await readFile(
  new globalThis.URL("../chrome-extension/popup.html", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(
    new globalThis.URL("../chrome-extension/manifest.json", import.meta.url),
    "utf8",
  ),
);

test("accepts only fixed Gemini hosts and canonical notebook pathnames", () => {
  for (const host of ["notebook.google.com", "notebooklm.google.com"]) {
    assert.equal(isGeminiNotebookHome(`https://${host}/?hl=en`), true);
    assert.equal(
      canonicalNotebookPathname(
        `https://${host}/notebook/abc_DEF-123?hl=en#sources`,
      ),
      "/notebook/abc_DEF-123",
    );
    assert.equal(
      canonicalNotebookPathname(`https://${host}/notebook/abc_DEF-123/`),
      "/notebook/abc_DEF-123",
    );
  }

  for (const url of [
    "http://notebook.google.com/notebook/example",
    "https://notebook.google.com.evil.example/notebook/example",
    "https://notebook.google.com/notebook/example/extra",
    "https://notebook.google.com/notebook/%2Fprivate",
    "not a URL",
  ]) {
    assert.equal(canonicalNotebookPathname(url), null);
  }
  assert.equal(
    readCanonicalNotebookPathname("/notebook/example"),
    "/notebook/example",
  );
  assert.equal(readCanonicalNotebookPathname("/notebook/example/"), null);
  assert.equal(readDestination("new"), "new");
  assert.equal(readDestination("active-or-new"), "active-or-new");
  assert.equal(readDestination("existing"), null);
});

test("refuses a new-job destination on an existing notebook before creation", async () => {
  let createCalls = 0;
  await assert.rejects(
    prepareBrowserDestination({
      destination: "new",
      getCurrentUrl: () =>
        "https://notebook.google.com/notebook/existing-notebook",
      createNotebook: async () => {
        createCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.message, OPEN_HOME_GUIDANCE);
      return true;
    },
  );
  assert.equal(createCalls, 0);
});

test("retains an active notebook only for active-or-new jobs", async () => {
  for (const [url, notebookPathname] of [
    [
      "https://notebook.google.com/notebook/existing-notebook?hl=en#sources",
      "/notebook/existing-notebook",
    ],
    [
      "https://notebooklm.google.com/notebook/legacy-detail/",
      "/notebook/legacy-detail",
    ],
  ]) {
    const binding = await prepareBrowserDestination({
      destination: "active-or-new",
      getCurrentUrl: () => url,
      createNotebook: async () => assert.fail("must not create a notebook"),
    });

    assert.deepEqual(binding, {
      createdNewNotebook: false,
      destination: "active-or-new",
      notebookPathname,
    });
    assert.equal(Object.isFrozen(binding), true);
  }
});

test("active-or-new creates and binds a new detail from home", async () => {
  let currentUrl = "https://notebook.google.com/";
  let createCalls = 0;
  const binding = await prepareBrowserDestination({
    destination: "active-or-new",
    getCurrentUrl: () => currentUrl,
    createNotebook: async () => {
      createCalls += 1;
      currentUrl =
        "https://notebook.google.com/notebook/active-or-new-created#sources";
      return true;
    },
  });

  assert.equal(createCalls, 1);
  assert.deepEqual(binding, {
    createdNewNotebook: true,
    destination: "active-or-new",
    notebookPathname: "/notebook/active-or-new-created",
  });
});

test("creates and binds a notebook from home before returning", async () => {
  let currentUrl = "https://notebook.google.com/";
  let createCalls = 0;
  const binding = await prepareBrowserDestination({
    destination: "new",
    getCurrentUrl: () => currentUrl,
    createNotebook: async () => {
      createCalls += 1;
      currentUrl =
        "https://notebook.google.com/notebook/new-notebook?source=zotero";
      return true;
    },
  });

  assert.equal(createCalls, 1);
  assert.deepEqual(binding, {
    createdNewNotebook: true,
    destination: "new",
    notebookPathname: "/notebook/new-notebook",
  });
});

test("requires explicit creation success before binding a new destination", async () => {
  for (const result of [false, undefined, null]) {
    let currentUrl = "https://notebook.google.com/";
    await assert.rejects(
      prepareBrowserDestination({
        destination: "new",
        getCurrentUrl: () => currentUrl,
        createNotebook: async () => {
          currentUrl =
            "https://notebook.google.com/notebook/unrelated-notebook";
          return result;
        },
      }),
      /did not open the prepared notebook/u,
    );
  }
});

test("popup preparation skips legacy jobs and validates the bound response", async () => {
  let messages = 0;
  assert.equal(
    await requestPreparedDestination({
      jobId: null,
      destination: null,
      sendMessage: async () => {
        messages += 1;
      },
    }),
    null,
  );
  assert.equal(messages, 0);

  const binding = await requestPreparedDestination({
    jobId: "job-id",
    destination: "new",
    sendMessage: async (message) => {
      messages += 1;
      assert.deepEqual(message, {
        action: PREPARE_DESTINATION_ACTION,
        destination: "new",
      });
      return {
        success: true,
        createdNewNotebook: true,
        destination: "new",
        notebookPathname: "/notebook/prepared-notebook",
      };
    },
  });
  assert.deepEqual(binding, {
    createdNewNotebook: true,
    destination: "new",
    notebookPathname: "/notebook/prepared-notebook",
  });
  assert.equal(messages, 1);

  const activeBinding = await requestPreparedDestination({
    jobId: "active-job-id",
    destination: "active-or-new",
    sendMessage: async (message) => {
      assert.deepEqual(message, {
        action: PREPARE_DESTINATION_ACTION,
        destination: "active-or-new",
      });
      return {
        success: true,
        createdNewNotebook: false,
        destination: "active-or-new",
        notebookPathname: "/notebook/current-detail",
      };
    },
  });
  assert.deepEqual(activeBinding, {
    createdNewNotebook: false,
    destination: "active-or-new",
    notebookPathname: "/notebook/current-detail",
  });

  await assert.rejects(
    requestPreparedDestination({
      jobId: "active-job-id",
      destination: "active-or-new",
      sendMessage: async () => ({
        success: true,
        createdNewNotebook: true,
        destination: "new",
        notebookPathname: "/notebook/rewritten-detail",
      }),
    }),
    /invalid import destination/,
  );

  await assert.rejects(
    requestPreparedDestination({
      jobId: "job-id",
      destination: "new",
      sendMessage: async () => ({
        success: true,
        createdNewNotebook: true,
        destination: "active-or-new",
        notebookPathname: "/notebook/prepared-notebook",
      }),
    }),
    /invalid import destination/,
  );
  await assert.rejects(
    requestPreparedDestination({
      jobId: "job-id",
      destination: "new",
      sendMessage: async () => {
        throw new Error("private transport detail");
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        globalThis.ZoteroUploadDestination.PREPARATION_FAILED_GUIDANCE,
      );
      return true;
    },
  );
});

test("destination binding rejects navigation to a different notebook", () => {
  const binding = {
    createdNewNotebook: true,
    destination: "new",
    notebookPathname: "/notebook/prepared-notebook",
  };
  assert.equal(
    isDestinationBoundToUrl(
      binding,
      "https://notebook.google.com/notebook/prepared-notebook?hl=en",
    ),
    true,
  );
  assert.equal(
    isDestinationBoundToUrl(
      binding,
      "https://notebook.google.com/notebook/different-notebook",
    ),
    false,
  );
  assert.equal(
    isDestinationBoundToUrl(binding, "https://notebook.google.com/"),
    false,
  );

  const activeBinding = {
    createdNewNotebook: false,
    destination: "active-or-new",
    notebookPathname: "/notebook/current-detail",
  };
  assert.equal(
    isDestinationBoundToUrl(
      activeBinding,
      "https://notebook.google.com/notebook/current-detail?hl=en#sources",
    ),
    true,
  );
  assert.equal(
    isDestinationBoundToUrl(
      activeBinding,
      "https://notebook.google.com/notebook/another-detail",
    ),
    false,
  );
});

test("requires new jobs to bind a newly created notebook and sanitizes errors", () => {
  assert.deepEqual(
    readDestinationBinding("new", "/notebook/new-notebook", true),
    {
      createdNewNotebook: true,
      destination: "new",
      notebookPathname: "/notebook/new-notebook",
    },
  );
  assert.equal(
    readDestinationBinding("new", "/notebook/existing-notebook", false),
    null,
  );
  assert.deepEqual(
    readDestinationBinding(
      "active-or-new",
      "/notebook/existing-notebook",
      false,
    ),
    {
      createdNewNotebook: false,
      destination: "active-or-new",
      notebookPathname: "/notebook/existing-notebook",
    },
  );
  assert.equal(readPreparationError(OPEN_HOME_GUIDANCE), OPEN_HOME_GUIDANCE);
  assert.equal(
    readPreparationError("private remote or DOM error"),
    globalThis.ZoteroUploadDestination.PREPARATION_FAILED_GUIDANCE,
  );
});

test("loads and completes destination preflight before batch bytes", () => {
  const prepareIndex = popupSource.indexOf(
    "preparedDestination = await requestPreparedDestination",
  );
  const beginIndex = popupSource.indexOf('action: "uploadBatchBegin"');
  const fileFetchIndex = popupSource.indexOf("`${ZOTERO_BASE}/file`");
  assert.ok(prepareIndex >= 0);
  assert.ok(beginIndex > prepareIndex);
  assert.ok(fileFetchIndex > beginIndex);
  assert.match(contentSource, /createdNotebook = job\.createdNewNotebook/u);
  assert.match(contentSource, /readPreparationError\(error\?\.message\)/u);
  assert.match(popupSource, /destination: stagedDestination/u);
  assert.match(
    popupSource,
    /beginMessage\.destination = preparedDestination\.destination/u,
  );

  const contentScripts = manifest.content_scripts.find((entry) =>
    entry.js?.includes("content.js"),
  ).js;
  assert.ok(
    contentScripts.indexOf("destination.js") <
      contentScripts.indexOf("upload-handoff.js"),
  );
  assert.ok(
    popupHTML.indexOf('src="destination.js"') <
      popupHTML.indexOf('src="popup.js"'),
  );
});
