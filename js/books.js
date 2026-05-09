(function () {
  var GOODREADS_PROFILE = "https://www.goodreads.com/user/show/185559715";
  /** Only show the N most recently updated titles on “currently reading”. */
  var CURRENTLY_READING_LIMIT = 3;
  /** Snapshot from Goodreads RSS (no browser CORS); regenerate with tools/fetch_goodreads_shelves.py */
  var BOOKS_DATA_URL = "books-data.json";
  var FETCH_TIMEOUT_MS = 12000;

  function fetchWithTimeout(url) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    return fetch(url, {
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    }).finally(function () {
      clearTimeout(timeoutId);
    });
  }

  function latestCurrentlyReading(items) {
    if (!items || !items.length) return [];
    var scored = items.map(function (b) {
      var t = Date.parse(b.pubDate || "");
      return { b: b, t: isNaN(t) ? 0 : t };
    });
    scored.sort(function (a, c) {
      return c.t - a.t;
    });
    var out = [];
    for (var i = 0; i < scored.length && out.length < CURRENTLY_READING_LIMIT; i++) {
      out.push(scored[i].b);
    }
    return out;
  }

  function extractAuthor(html) {
    if (!html || typeof html !== "string") return "";
    var m = html.match(/author:\s*([^<\n]+)/i);
    return m ? m[1].trim() : "";
  }

  function extractBookUrl(html, fallback) {
    if (!html || typeof html !== "string") return fallback || "";
    var m = html.match(
      /href="(https:\/\/www\.goodreads\.com\/book\/show\/[^"]+)/i
    );
    if (!m) return fallback || "";
    return m[1].replace(/&amp;/g, "&");
  }

  /**
   * Goodreads RSS thumbnails are tiny (_SY75_ etc.). Swap the size token for a
   * large cover so grid cells stay sharp on retina displays.
   */
  function largerCover(url) {
    if (!url) return "";
    if (url.indexOf("nophoto") !== -1) return url;
    if (url.indexOf("gr-assets.com") === -1) return url;
    return url.replace(/\._S[XY]\d+_\./g, "._SY475_.");
  }

  function isAllowedImageHost(hostname) {
    return (
      hostname === "i.gr-assets.com" ||
      hostname === "s.gr-assets.com" ||
      hostname === "www.goodreads.com"
    );
  }

  function safeImageUrl(url) {
    if (!url || typeof url !== "string") return "";
    try {
      var u = new URL(url);
      if (u.protocol !== "https:") return "";
      if (!isAllowedImageHost(u.hostname)) return "";
      return u.href;
    } catch (e) {
      return "";
    }
  }

  function setSectionState(section, state, message) {
    var status = section.querySelector("[data-books-status]");
    if (!status) return;
    status.hidden = state === "ready";
    status.textContent = message || "";
    status.setAttribute("data-state", state);
  }

  function renderList(ul, items) {
    ul.innerHTML = "";
    if (!items || !items.length) {
      var empty = document.createElement("li");
      empty.className = "books-empty";
      empty.textContent = "No books on this shelf yet.";
      ul.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var title = item.title || "Untitled";
      var thumb = safeImageUrl(item.thumbnail || "");
      if (!thumb) {
        var fromDesc =
          item.description &&
          item.description.match(/src="(https:\/\/[^"]+)"/i);
        if (fromDesc) thumb = safeImageUrl(fromDesc[1]);
      }
      var cover = largerCover(thumb) || thumb;
      var author = extractAuthor(item.description || item.content || "");
      var bookHref = extractBookUrl(
        item.description || item.content || "",
        item.link
      );

      var li = document.createElement("li");
      var a = document.createElement("a");
      a.className = "book-card";
      a.href = bookHref || GOODREADS_PROFILE;
      a.target = "_blank";
      a.rel = "noopener noreferrer";

      var fig = document.createElement("div");
      fig.className = "book-card__cover";
      if (cover) {
        var img = document.createElement("img");
        img.src = cover;
        img.alt = "";
        img.width = 316;
        img.height = 474;
        img.loading = "lazy";
        img.decoding = "async";
        fig.appendChild(img);
      } else {
        fig.className += " book-card__cover--placeholder";
        fig.setAttribute("aria-hidden", "true");
        var ph = document.createElement("span");
        ph.className = "book-card__ph";
        var phIcon = document.createElement("i");
        phIcon.className = "fas fa-book";
        ph.appendChild(phIcon);
        fig.appendChild(ph);
      }

      var body = document.createElement("div");
      body.className = "book-card__body";
      var t = document.createElement("span");
      t.className = "book-card__title";
      t.textContent = title;
      body.appendChild(t);
      if (author) {
        var au = document.createElement("span");
        au.className = "book-card__author";
        au.textContent = author;
        body.appendChild(au);
      }

      var chev = document.createElement("span");
      chev.className = "book-card__chevron";
      chev.setAttribute("aria-hidden", "true");
      var chevIcon = document.createElement("i");
      chevIcon.className = "fas fa-external-link-alt";
      chev.appendChild(chevIcon);

      a.appendChild(fig);
      a.appendChild(body);
      a.appendChild(chev);
      li.appendChild(a);
      ul.appendChild(li);
    });
  }

  /**
   * Resolve js/books-data.json next to this script (same folder as books.js).
   */
  function snapshotUrl() {
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      var s = scripts[i];
      if (s.src && /books\.js(\?|#|$)/i.test(s.src)) {
        return s.src.replace(/books\.js(\?[^#]*)?(#.*)?$/i, BOOKS_DATA_URL);
      }
    }
    return new URL("js/" + BOOKS_DATA_URL, window.location.href).href;
  }

  function loadSnapshot() {
    return fetchWithTimeout(snapshotUrl()).then(function (res) {
      if (!res.ok) throw new Error("snapshot HTTP " + res.status);
      return res.json();
    });
  }

  function init() {
    var readingSection = document.getElementById("books-reading-section");
    var readSection = document.getElementById("books-read-section");
    if (!readingSection || !readSection) return;

    var ulCur = document.getElementById("books-currently-reading");
    var ulRead = document.getElementById("books-read");
    if (!ulCur || !ulRead) return;

    setSectionState(readingSection, "loading", "Loading…");
    setSectionState(readSection, "loading", "Loading…");

    loadSnapshot()
      .then(function (data) {
        var cur = (data && data.currentlyReading) || [];
        var read = (data && data.read) || [];
        renderList(ulCur, latestCurrentlyReading(cur));
        setSectionState(readingSection, "ready", "");
        renderList(ulRead, read);
        setSectionState(readSection, "ready", "");
      })
      .catch(function () {
        var msg =
          "Book lists load from a local snapshot (js/books-data.json). " +
          "If you’re developing locally, run: python3 tools/fetch_goodreads_shelves.py";
        setSectionState(readingSection, "error", msg);
        setSectionState(readSection, "error", msg);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
