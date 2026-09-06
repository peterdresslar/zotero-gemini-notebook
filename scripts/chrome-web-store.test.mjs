import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inflateSync } from "node:zlib";

const projectFile = (path) => new globalThis.URL(`../${path}`, import.meta.url);

const [
  privacyPolicy,
  listing,
  packageJSON,
  manifest,
  storeIcon16,
  storeIcon48,
  storeIcon128,
  runtimeIcon16,
  runtimeIcon48,
  runtimeIcon128,
  promo,
] = await Promise.all([
  readFile(projectFile("PRIVACY.md"), "utf8"),
  readFile(projectFile("chrome-web-store/listing.md"), "utf8"),
  readFile(projectFile("package.json"), "utf8").then(JSON.parse),
  readFile(projectFile("chrome-extension/manifest.json"), "utf8").then(
    JSON.parse,
  ),
  readFile(projectFile("chrome-web-store/assets/icon-16.png")),
  readFile(projectFile("chrome-web-store/assets/icon-48.png")),
  readFile(projectFile("chrome-web-store/assets/icon-128.png")),
  readFile(projectFile("chrome-extension/icons/icon16.png")),
  readFile(projectFile("chrome-extension/icons/icon48.png")),
  readFile(projectFile("chrome-extension/icons/icon128.png")),
  readFile(projectFile("chrome-web-store/assets/promo-440x280.png")),
]);

function readPngHeader(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function inspectRgbaArtwork(buffer) {
  const { width, height, colorType } = readPngHeader(buffer);
  assert.equal(buffer[24], 8, "Store icons must use 8-bit color channels");
  assert.equal(colorType, 6, "Store icons must use RGBA color");
  assert.equal(buffer[28], 0, "Store icons must not be interlaced");

  const idatChunks = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idatChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }

  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  assert.equal(inflated.length, height * (rowLength + 1));
  let previousRow = Buffer.alloc(rowLength);
  let hasTransparentPixel = false;
  let hasOpaquePixel = false;
  const alphaBounds = {
    minX: width,
    maxX: -1,
    minY: height,
    maxY: -1,
  };
  const foregroundBounds = { ...alphaBounds };
  const semanticPixelCounts = {
    arrow: 0,
    notebook: 0,
    white: 0,
  };

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const inputOffset = rowIndex * (rowLength + 1);
    const filter = inflated[inputOffset];
    const row = Buffer.alloc(rowLength);
    for (let index = 0; index < rowLength; index += 1) {
      const raw = inflated[inputOffset + index + 1];
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
      const above = previousRow[index];
      const upperLeft =
        index >= bytesPerPixel ? previousRow[index - bytesPerPixel] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        predictor = paethPredictor(left, above, upperLeft);
      } else {
        assert.fail(`Unsupported PNG filter ${filter}`);
      }
      row[index] = (raw + predictor) & 0xff;
    }
    for (let index = 0; index < rowLength; index += bytesPerPixel) {
      const x = index / bytesPerPixel;
      const red = row[index];
      const green = row[index + 1];
      const blue = row[index + 2];
      const alpha = row[index + 3];
      hasTransparentPixel ||= alpha < 255;
      hasOpaquePixel ||= alpha === 255;
      if (alpha > 0) {
        alphaBounds.minX = Math.min(alphaBounds.minX, x);
        alphaBounds.maxX = Math.max(alphaBounds.maxX, x);
        alphaBounds.minY = Math.min(alphaBounds.minY, rowIndex);
        alphaBounds.maxY = Math.max(alphaBounds.maxY, rowIndex);
      }
      if (alpha > 0 && (red !== 24 || green !== 50 || blue !== 74)) {
        foregroundBounds.minX = Math.min(foregroundBounds.minX, x);
        foregroundBounds.maxX = Math.max(foregroundBounds.maxX, x);
        foregroundBounds.minY = Math.min(foregroundBounds.minY, rowIndex);
        foregroundBounds.maxY = Math.max(foregroundBounds.maxY, rowIndex);
      }
      if (alpha === 255 && red === 244 && green === 185 && blue === 66) {
        semanticPixelCounts.arrow += 1;
      }
      if (alpha === 255 && red === 85 && green === 194 && blue === 178) {
        semanticPixelCounts.notebook += 1;
      }
      if (alpha === 255 && red === 255 && green === 255 && blue === 255) {
        semanticPixelCounts.white += 1;
      }
    }
    previousRow = row;
  }

  return {
    alphaBounds,
    foregroundBounds,
    hasOpaquePixel,
    hasTransparentPixel,
    semanticPixelCounts,
  };
}

test("pins the Store-facing extension identity and rollout versions", () => {
  assert.equal(packageJSON.version, "0.5.0");
  assert.deepEqual(packageJSON.companionCompatibility.validVersions, [
    "0.4.0",
    "0.4.1",
    "0.5.0",
  ]);
  assert.equal(manifest.version, packageJSON.version);
  assert.equal(manifest.name, "Zotero-Gemini Notebook Connector");
  assert.match(
    listing,
    new RegExp(`^\\*\\*Name:\\*\\* ${manifest.name}$`, "mu"),
  );
});

test("provides correctly sized required Store artwork drafts", () => {
  for (const [size, storeIcon, runtimeIcon, expectedAlphaBounds] of [
    [16, storeIcon16, runtimeIcon16, { minX: 2, maxX: 13, minY: 2, maxY: 13 }],
    [48, storeIcon48, runtimeIcon48, { minX: 6, maxX: 41, minY: 6, maxY: 41 }],
    [
      128,
      storeIcon128,
      runtimeIcon128,
      { minX: 16, maxX: 111, minY: 16, maxY: 111 },
    ],
  ]) {
    assert.deepEqual(runtimeIcon, storeIcon);
    assert.deepEqual(readPngHeader(storeIcon), {
      width: size,
      height: size,
      colorType: 6,
    });
    const artwork = inspectRgbaArtwork(storeIcon);
    assert.equal(artwork.hasOpaquePixel, true);
    assert.equal(artwork.hasTransparentPixel, true);
    assert.deepEqual(artwork.alphaBounds, expectedAlphaBounds);
    assert.ok(artwork.semanticPixelCounts.arrow > 0);
    assert.ok(artwork.semanticPixelCounts.notebook > 0);
    assert.ok(artwork.semanticPixelCounts.white > 0);
    assert.ok(
      Math.abs(
        (artwork.foregroundBounds.minX + artwork.foregroundBounds.maxX) / 2 -
          size / 2,
      ) <= 1,
      `${size}px foreground must remain horizontally centered`,
    );
  }
  assert.deepEqual(readPngHeader(promo), {
    width: 440,
    height: 280,
    colorType: 2,
  });
});

test("keeps the listing summary within the Chrome Web Store limit", () => {
  const summary = listing.match(/^\*\*Summary:\*\* (?<summary>.+)$/mu)?.groups
    ?.summary;
  assert.ok(summary);
  assert.ok(summary.length <= 132, `Store summary is ${summary.length} chars`);
});

test("keeps Store disclosures aligned with the public privacy policy", () => {
  for (const requiredPolicyText of [
    "127.0.0.1",
    "Google is the only third party",
    "does not use persistent browser storage",
    "staged metadata only while the popup is open",
    "file data only while an import is being prepared or attempted",
    "Limited Use",
  ]) {
    assert.match(privacyPolicy, new RegExp(requiredPolicyText, "u"));
  }

  for (const requiredListingText of [
    "Transfer sources explicitly staged by the user",
    "requests no general Chrome API permissions",
    "does not load or execute remote code",
    "PRIVACY.md",
    `releases/download/v${packageJSON.version}/zotero-gemini-notebook.xpi`,
  ]) {
    assert.match(listing, new RegExp(requiredListingText, "u"));
  }
});
