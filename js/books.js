(function () {
  var GOODREADS_USER_ID = "185559715";
  var GOODREADS_PROFILE = "https://www.goodreads.com/user/show/" + GOODREADS_USER_ID;
  /** Goodreads RSS caps a single response; we paginate with per_page=100. */
  var RSS_PAGE_SIZE = 100;
  var MAX_SHELF_PAGES = 30;
  /** Only show the N most recently updated titles on “currently reading”. */
  var CURRENTLY_READING_LIMIT = 3;
  var FETCH_TIMEOUT_MS = 5000;
  var RSS_PROXY_RAW = "https://api.allorigins.win/raw?url=";
  var RSS_PROXY_GET = "https://api.allorigins.win/get?url=";

  function shelfRssBase(shelf) {
    return (
      "https://www.goodreads.com/review/list_rss/" +
      GOODREADS_USER_ID +
      "?shelf=" +
      encodeURIComponent(shelf) +
      "&per_page=" +
      RSS_PAGE_SIZE
    );
  }

  function fetchWithTimeout(url) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    return fetch(url, {
      credentials: "omit",
      signal: controller.signal
    }).finally(function () {
      clearTimeout(timeoutId);
    });
  }

  function fetchRssXml(targetUrl) {
    var rawUrl = RSS_PROXY_RAW + encodeURIComponent(targetUrl);
    var getUrl = RSS_PROXY_GET + encodeURIComponent(targetUrl);
    var rawReq = fetchWithTimeout(rawUrl)
      .then(function (res) {
        if (!res.ok) throw new Error("Proxy raw HTTP " + res.status);
        return res.text();
      })
      .then(function (xml) {
        if (!xml || xml.indexOf("<rss") === -1) {
          throw new Error("Proxy raw invalid body");
        }
        return xml;
      });

    var getReq = fetchWithTimeout(getUrl)
      .then(function (res) {
        if (!res.ok) throw new Error("Proxy get HTTP " + res.status);
        return res.json();
      })
      .then(function (payload) {
        if (!payload || typeof payload.contents !== "string") {
          throw new Error("Proxy get invalid body");
        }
        if (payload.contents.indexOf("<rss") === -1) {
          throw new Error("Proxy get non-rss body");
        }
        return payload.contents;
      });

    // Use the first successful proxy response.
    return Promise.any([rawReq, getReq]);
  }

  function firstChildText(parent, tag) {
    if (!parent) return "";
    var nodes = parent.getElementsByTagName(tag);
    if (!nodes || !nodes.length) return "";
    var t = nodes[0].textContent;
    return t ? t.trim() : "";
  }

  function parseGoodreadsItems(xmlString) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlString, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("RSS parse error");
    }
    var raw = doc.getElementsByTagName("item");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      var desc = firstChildText(item, "description");
      out.push({
        title: firstChildText(item, "title"),
        link: firstChildText(item, "link"),
        pubDate: firstChildText(item, "pubDate"),
        thumbnail:
          firstChildText(item, "book_medium_image_url") ||
          firstChildText(item, "book_image_url") ||
          firstChildText(item, "book_small_image_url"),
        description: desc,
        content: desc,
        book_id: firstChildText(item, "book_id")
      });
    }
    return out;
  }

  function fetchShelfAllPages(shelf) {
    var base = shelfRssBase(shelf);
    var merged = [];
    var seen = {};

    function step(page) {
      if (page > MAX_SHELF_PAGES) return Promise.resolve(merged);
      var url = base + "&page=" + page;
      return fetchRssXml(url)
        .then(parseGoodreadsItems)
        .then(function (chunk) {
          if (!chunk.length) return merged;
          for (var i = 0; i < chunk.length; i++) {
            var b = chunk[i];
            var id = b.book_id || b.link || b.title;
            if (seen[id]) continue;
            seen[id] = 1;
            merged.push(b);
          }
          if (chunk.length < RSS_PAGE_SIZE) return merged;
          return step(page + 1);
        })
        .catch(function (err) {
          if (page === 1) throw err;
          return merged;
        });
    }

    return step(1);
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

  function init() {
    var readingSection = document.getElementById("books-reading-section");
    var readSection = document.getElementById("books-read-section");
    if (!readingSection || !readSection) return;

    var ulCur = document.getElementById("books-currently-reading");
    var ulRead = document.getElementById("books-read");
    if (!ulCur || !ulRead) return;

    setSectionState(readingSection, "loading", "Loading…");
    setSectionState(readSection, "loading", "Loading…");

    // Load each shelf independently so currently-reading can render quickly.
    fetchShelfAllPages("currently-reading")
      .then(function (items) {
        renderList(ulCur, latestCurrentlyReading(items || []));
        setSectionState(readingSection, "ready", "");
      })
      .catch(function () {
        setSectionState(
          readingSection,
          "error",
          "Could not load currently reading right now. Please refresh later."
        );
      });

    fetchShelfAllPages("read")
      .then(function (items) {
        renderList(ulRead, items || []);
        setSectionState(readSection, "ready", "");
      })
      .catch(function () {
        setSectionState(
          readSection,
          "error",
          "Could not load read shelf right now. Please refresh later."
        );
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
