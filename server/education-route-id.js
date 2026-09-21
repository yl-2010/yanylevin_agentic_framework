/**
 * Path ids for /education (and /jype /debate).
 *
 * encodeURIComponent leaves `#` as `%23`. Drag-to-tab (and some browsers)
 * decode that to a real `#`, treat it as the fragment, and the SPA looks up a
 * truncated id ("QA Sep 24 " instead of "QA Sep 24 #1 …"). `*` stands in for
 * `%` so a drag cannot mint a hash.
 */

export function encodeEducationRouteId(id) {
  return encodeURIComponent(String(id ?? "")).replace(/%/g, "*");
}

export function decodeEducationRouteId(raw) {
  const s = String(raw ?? "");
  if (!s) return s;
  try {
    const decoded = s.includes("*")
      ? decodeURIComponent(s.replace(/\*/g, "%"))
      : decodeURIComponent(s);
    return decoded.normalize("NFC");
  } catch {
    try {
      return s.normalize("NFC");
    } catch {
      return s;
    }
  }
}

/**
 * Old `%23` links that were dragged land the rest of the Finder name in the
 * hash, often with `?class=` / `?project=` after it.
 * @param {string} id
 * @param {URLSearchParams} params
 * @param {string} hash `location.hash`, including the leading `#`
 * @returns {{ id: string, params: URLSearchParams }}
 */
export function recoverEducationHashSplit(id, params, hash) {
  const src = String(hash || "");
  const nextParams = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (src.length < 2 || !src.startsWith("#")) {
    return { id, params: nextParams };
  }
  const rest = src.slice(1);
  const qAt = rest.indexOf("?");
  const namePart = qAt >= 0 ? rest.slice(0, qAt) : rest;
  const extraQuery = qAt >= 0 ? rest.slice(qAt + 1) : "";
  const looksSplit =
    /(?:^|&)(class|project|classId|projectId)=/.test(extraQuery) ||
    /^\d+(\s|$)/.test(namePart);
  if (!looksSplit || String(id).includes("#")) {
    return { id, params: nextParams };
  }
  let nameDecoded = namePart;
  try {
    nameDecoded = decodeURIComponent(namePart.replace(/\+/g, " "));
  } catch {
    /* keep */
  }
  const recovered = `${id}#${nameDecoded}`.normalize("NFC");
  if (!extraQuery) return { id: recovered, params: nextParams };
  const merged = new URLSearchParams(nextParams);
  new URLSearchParams(extraQuery).forEach((value, key) => {
    if (!merged.get(key)) merged.set(key, value);
  });
  return { id: recovered, params: merged };
}
