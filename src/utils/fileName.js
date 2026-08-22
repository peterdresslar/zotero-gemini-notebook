export function getSafeFileName(preferredName, filePath) {
  for (const candidate of [preferredName, filePath]) {
    if (typeof candidate !== "string") continue;
    const segments = candidate.split(/[\\/]/).filter(Boolean);
    const baseName = Array.from(segments[segments.length - 1] ?? "")
      .filter((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      })
      .join("")
      .trim();
    if (baseName && baseName !== "." && baseName !== "..") return baseName;
  }
  return "unknown";
}
