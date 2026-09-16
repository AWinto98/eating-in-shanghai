/* The landing card: who wrote what, and where to buy the guide.
 *
 * Shown on the first visit and reachable afterwards from "About" in the panel
 * footer. It is filled from config.js rather than hard-coded here, so the
 * credit cannot drift from the one used in the popups.
 */

const SEEN_KEY = "seen-about";

function fillLanding() {
  document.getElementById("landing-guide").textContent = GUIDE.title;
  document.getElementById("landing-author").textContent = GUIDE.author;
  document.getElementById("landing-eyebrow").textContent = LANDING.eyebrow;
  document.getElementById("landing-scope").textContent = LANDING.scope;

  // Sits with the permission line rather than in the lead, which names the
  // guide and its author -- a second name in that sentence would read as
  // co-authorship of the guide itself. rel="noreferrer" matches the other
  // outbound links, so the hosted URL stays out of anyone's analytics while it
  // is unlisted.
  const builder = document.getElementById("landing-builder");
  if (BUILDER.name) {
    const who = BUILDER.url
      ? `<a href="${esc(BUILDER.url)}" target="_blank" rel="noopener noreferrer">` +
        `${esc(BUILDER.name)}</a>`
      : esc(BUILDER.name);
    builder.innerHTML = `Map and walking routes by ${who}.`;
  }

  const buy = document.getElementById("landing-buy");
  if (!LANDING.showBuyCard) {
    // The buyer edition ships inside the purchase. Selling the guide to
    // someone who has just bought it reads as a mistake, so this thanks them
    // instead -- the one place the two editions differ visibly.
    buy.className = "landing-buy landing-thanks";
    buy.textContent = LANDING.buyerNote;
  } else if (GUIDE.url) {
    buy.innerHTML =
      `<a href="${GUIDE.url}" target="_blank" rel="noopener noreferrer">` +
      `Buy the guide &rarr;</a>`;
  } else {
    // Better an obvious gap than a link pointing somewhere invented.
    buy.innerHTML =
      `<span class="landing-missing">Add the link to buy the guide in ` +
      `<code>web/js/config.js</code></span>`;
  }
}

function showLanding() {
  document.getElementById("landing").hidden = false;
  document.getElementById("app").inert = true;
  document.getElementById("landing-enter").focus();
}

function hideLanding() {
  document.getElementById("landing").hidden = true;
  document.getElementById("app").inert = false;
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch (err) {
    /* not remembering is survivable */
  }
}

function initAbout() {
  fillLanding();

  let seen = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch (err) {
    seen = null;
  }
  if (!seen) showLanding();

  document.getElementById("landing-enter").addEventListener("click", hideLanding);
  document.getElementById("show-about").addEventListener("click", showLanding);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("landing").hidden) {
      hideLanding();
    }
  });
}

initAbout();
