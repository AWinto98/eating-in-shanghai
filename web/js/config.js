/* Everything about the source guide lives here, so the credit and the link to
 * buy it are stated in one place and cannot drift apart. The landing card and
 * every popup read from this.
 *
 * This file is also where every decision St. Cavish might reverse at his final
 * pass is parked. He sees the map once, near the end, so anything he dislikes
 * has to be a one-line change here rather than a hunt through the code.
 */
const GUIDE = {
  author: "Christopher St. Cavish",
  title: "Guide to Eating in Shanghai 2026",
  url: "https://stcavish.gumroad.com/l/yllgxi",
  handle: "saintcavish",
};

/* The map, as distinct from the writing -- kept beside GUIDE because the
 * landing card credits both and neither should be editable in two places.
 *
 * The credit is deliberately specific about what was built rather than a bare
 * "by": the boundary between his words and this map is the thing worth making
 * obvious, and "map and walking routes" draws it in four words. It stays out of
 * the popups for the same reason -- those credit his prose, and a second name
 * there would read as a claim on it.
 *
 * Set `url` to "" to render the name as plain text instead of a link.
 */
const BUILDER = {
  name: "A. Winton",
  url: "https://github.com/AWinto98",
};

/* --- the reversible decisions ---------------------------------------- */

/* Two editions ship from one codebase.
 *
 *   "buyer"  - the download bundled with the Gumroad purchase. No
 *              buy-the-guide card: selling the guide to someone who has just
 *              bought it reads as a mistake.
 *   "public" - the hosted link. The buy card stays, so the link works as
 *              advertising for the guide wherever it ends up.
 *
 * Text quantity is no longer one of the differences -- see TEXT below.
 *
 * The build script sets this; "public" is the safer default if it is ever left
 * alone, because it is the edition that still credits and sells the guide.
 */
const EDITION = window.EDITION_OVERRIDE || "public";

const TEXT = {
  /* "extract" quotes whole sentences up to a bound; "full" quotes the entry.
   *
   * BOTH editions quote in full as of 2026-08-15, and this was St. Cavish's own
   * call rather than ours: he does not mind the words getting out, and the
   * price on the guide is there to make it feel premium rather than to fence
   * the text. This was the one decision earmarked to raise with him first, so
   * it is settled ahead of the final pass rather than at it.
   *
   * "extract" is kept working, and the bounds below with it, because that is
   * the reversal most likely to be wanted and it should stay a one-line change.
   */
  mode: "full",
  /* Bounds for "extract". Inert while mode is "full". */
  min: 90,
  max: 180,
};

/* What the landing card says. Someone who just bought the guide does not need
 * to be sold it again -- they get a thank-you instead.
 *
 * The scope line used to read "not published, not hosted, it runs only on my
 * own machine". That was true when this was a portfolio piece and is false in
 * both editions now, so it is stated per edition rather than left to rot.
 */
const LANDING = {
  showBuyCard: EDITION !== "buyer",
  buyerNote:
    "You already have the guide — this map is a companion to it. " +
    "Everything quoted here is the author's writing.",
  eyebrow: EDITION === "buyer"
    ? "Included with your copy of the guide"
    : "A companion to the guide",
  /* The public line used to promise "short extracts only". Both editions quote
   * in full now, so that sentence would be a false statement on the landing
   * card of the edition it describes. What is still true, and is the honest
   * version of the same point, is that the entry notes are only a part of the
   * guide. */
  scope: EDITION === "buyer"
    ? "Made with the author's permission and included with the guide. It is a " +
      "way to navigate his recommendations, not a replacement for reading them."
    : "Made with the author's permission, and it quotes his note on every " +
      "place in full. Those notes are one part of the guide — the book itself " +
      "is a great deal more, and worth having whole.",
};

/* --- data loading ----------------------------------------------------- */

/* The standalone build inlines every data file into the page, because a
 * double-clicked file:// page cannot fetch() at all. When BUNDLE is present the
 * loaders read from it; otherwise they fetch exactly as before. One helper
 * shared by map.js, walk.js and basemap.js, so the two builds cannot drift.
 *
 * Payloads are stashed as JSON *strings* and parsed on first use. Parsing all
 * 6.8MB up front would stall the page to answer a 1.5KB index, and most
 * visitors never open a region they did not start in.
 */
/* Where the data files sit relative to the page. In the source tree the page is
 * web/index.html and the data is a level up in data/. A hosted build puts
 * index.html at the root so the URL is the site itself rather than /web/, and
 * overrides this to "data/". The bundled build ignores it entirely. */
const DATA_BASE = (typeof window !== "undefined" && window.DATA_BASE_OVERRIDE) || "../data/";

const BUNDLE = (typeof window !== "undefined" && window.BUNDLE) || null;
const _bundleParsed = {};

function loadJSON(url) {
  const key = String(url).replace(/^.*\//, "");
  if (BUNDLE && Object.prototype.hasOwnProperty.call(BUNDLE, key)) {
    if (!(key in _bundleParsed)) {
      try {
        _bundleParsed[key] = JSON.parse(BUNDLE[key]);
      } catch (err) {
        return Promise.reject(new Error(`bundled ${key} is not valid JSON: ${err.message}`));
      }
    }
    return Promise.resolve(_bundleParsed[key]);
  }
  return fetch(url).then((resp) => {
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return resp.json();
  });
}
