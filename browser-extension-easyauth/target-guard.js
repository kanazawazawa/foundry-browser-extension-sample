(() => {
  const DEFAULT_ALLOWED_TARGET_ORIGINS = Object.freeze([
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "https://*.azurewebsites.net",
  ]);

  function normalizeAllowedOrigins(rawList) {
    if (!Array.isArray(rawList)) {
      return [...DEFAULT_ALLOWED_TARGET_ORIGINS];
    }
    const cleaned = rawList
      .map((item) => (typeof item === "string" ? item.trim().replace(/\/\*?$/, "") : ""))
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : [...DEFAULT_ALLOWED_TARGET_ORIGINS];
  }

  function tryParseOrigin(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return "";
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.origin.toLowerCase();
    } catch {
      return "";
    }
  }

  function matchesOriginPattern(parsedUrl, pattern) {
    const trimmed = String(pattern || "").trim().replace(/\/\*?$/, "");
    if (!trimmed) return false;

    const wildcardMatch = trimmed.match(/^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/i);
    if (wildcardMatch) {
      const expectedProto = `${wildcardMatch[1].toLowerCase()}:`;
      const baseHost = wildcardMatch[2].toLowerCase();
      const expectedPort = wildcardMatch[3] || "";
      const host = parsedUrl.hostname.toLowerCase();
      return (
        parsedUrl.protocol === expectedProto &&
        parsedUrl.port === expectedPort &&
        host.endsWith(`.${baseHost}`) &&
        host.length > baseHost.length + 1
      );
    }

    const exactOrigin = tryParseOrigin(trimmed);
    return Boolean(exactOrigin) && parsedUrl.origin.toLowerCase() === exactOrigin;
  }

  function isAllowedTargetUrl(
    urlStr,
    allowedOrigins = DEFAULT_ALLOWED_TARGET_ORIGINS,
    excludedUrl = ""
  ) {
    if (!urlStr || typeof urlStr !== "string") return false;
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const excludedOrigin = tryParseOrigin(excludedUrl);
    if (excludedOrigin && parsed.origin.toLowerCase() === excludedOrigin) {
      return false;
    }
    const patterns = normalizeAllowedOrigins(allowedOrigins);
    return patterns.some((pattern) => matchesOriginPattern(parsed, pattern));
  }

  globalThis.FoundryTargetGuard = {
    DEFAULT_ALLOWED_TARGET_ORIGINS,
    normalizeAllowedOrigins,
    isAllowedTargetUrl,
  };
})();
