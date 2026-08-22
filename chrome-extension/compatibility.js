export const COMPANION_COMPATIBILITY = Object.freeze({
  COMPATIBLE: "compatible",
  CHROME_UPDATE_REQUIRED: "chrome-update-required",
  ZOTERO_UPDATE_REQUIRED: "zotero-update-required",
  UNKNOWN: "unknown",
});

const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableSemver(version) {
  if (typeof version !== "string") return null;

  const match = STABLE_SEMVER_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareSemver(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function classifyChromeCompanionCompatibility(
  compatibleVersions,
  installedVersion,
) {
  // The published v0.2.0 Zotero plugin predates compatibility metadata. Its
  // endpoint contract remains compatible with newer companions, so allow that
  // one-way upgrade path. Newer backends must send an explicit list.
  if (compatibleVersions === undefined) {
    return COMPANION_COMPATIBILITY.COMPATIBLE;
  }

  if (!Array.isArray(compatibleVersions) || compatibleVersions.length === 0) {
    return COMPANION_COMPATIBILITY.UNKNOWN;
  }

  if (!compatibleVersions.every((version) => typeof version === "string")) {
    return COMPANION_COMPATIBILITY.UNKNOWN;
  }

  // An explicit allowlist match is authoritative, including for prereleases
  // that cannot participate in the stable-version direction check below.
  if (compatibleVersions.includes(installedVersion)) {
    return COMPANION_COMPATIBILITY.COMPATIBLE;
  }

  const installed = parseStableSemver(installedVersion);
  const advertised = compatibleVersions.map(parseStableSemver);
  if (!installed || advertised.some((version) => version === null)) {
    return COMPANION_COMPATIBILITY.UNKNOWN;
  }

  const comparisons = advertised.map((version) =>
    compareSemver(installed, version),
  );
  if (comparisons.every((comparison) => comparison > 0)) {
    return COMPANION_COMPATIBILITY.ZOTERO_UPDATE_REQUIRED;
  }
  if (comparisons.every((comparison) => comparison < 0)) {
    return COMPANION_COMPATIBILITY.CHROME_UPDATE_REQUIRED;
  }

  // An omitted version inside the advertised range is a deliberate or
  // ambiguous compatibility gap. Do not guess which component should change.
  return COMPANION_COMPATIBILITY.UNKNOWN;
}

export function getCompatibilityWarningCopy(compatibility, installedVersion) {
  if (compatibility === COMPANION_COMPATIBILITY.ZOTERO_UPDATE_REQUIRED) {
    return {
      status: "Zotero plugin update required",
      heading: `Chrome companion version ${installedVersion} is newer than the installed Zotero plugin`,
      guidance:
        "In Zotero, open Tools \u2192 Plugins, open the gear menu, choose Check for Updates, then return here and click Refresh.",
      linkText: "View releases and install the newest Zotero plugin",
    };
  }

  if (compatibility === COMPANION_COMPATIBILITY.CHROME_UPDATE_REQUIRED) {
    return {
      status: "Chrome companion update required",
      heading: `Chrome companion version ${installedVersion} is older than the installed Zotero plugin`,
      guidance:
        "Download the latest Chrome companion, replace the files in its existing folder, then click Reload on chrome://extensions/.",
      linkText: "View releases and install the newest Chrome companion",
    };
  }

  if (compatibility === COMPANION_COMPATIBILITY.UNKNOWN) {
    return {
      status: "Version compatibility could not be determined",
      heading: `Chrome companion version ${installedVersion} could not be matched to the installed Zotero plugin`,
      guidance:
        "Update the Zotero plugin and Chrome companion to the latest release, then click Refresh.",
      linkText: "View the latest release files",
    };
  }

  return null;
}
