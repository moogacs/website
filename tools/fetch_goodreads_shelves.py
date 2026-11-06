#!/usr/bin/env python3
"""
Fetch Goodreads shelves server-side (no CORS) and write js/books-data.json
for the static site. Re-run after your shelves change, or wire this into CI.

  python3 tools/fetch_goodreads_shelves.py

Goodreads retired its shelf RSS feeds in October 2026 and shelf pages now need
a sign-in, so this reads the public "custom widget" Goodreads offers for
embedding a shelf on other sites. The widget has no dates; it is requested
sorted by date added, newest first.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlencode

GOODREADS_USER_ID = "185559715"
# Upper bound on books per shelf; the widget has no paging.
MAX_BOOKS = 100
ATTEMPTS = 4
OUT_PATH = "js/books-data.json"
UA = "Mozilla/5.0 (compatible; mooga-books-fetch/1.0; +https://m-mooga.com)"


def _widget_url(shelf: str, sort: str) -> str:
    params = {
        "shelf": shelf,
        "num_books": MAX_BOOKS,
        "sort": sort,
        "order": "d",
        # Goodreads caches a widget by widget_id and ignores the other params
        # on later requests for the same id, so use a fresh one every request.
        "widget_id": f"{shelf}-{time.time_ns()}",
    }
    return (
        f"https://www.goodreads.com/review/custom_widget/{GOODREADS_USER_ID}"
        f"?{urlencode(params)}"
    )


def _widget_html(script: str) -> str:
    """The widget is JS: `var widget_code = '<escaped html>'` plus code that
    inserts it. Pull out and unescape the HTML string."""
    m = re.search(r"var widget_code = '(.*?)'\n", script, re.S)
    if not m:
        raise ValueError("widget response had no widget_code")
    return re.sub(r"\\(.)", lambda e: "\n" if e.group(1) == "n" else e.group(1), m.group(1))


def _book_id_from_cover(url: str) -> str:
    # e.g. .../books/1475538019l/113934._SX50_.jpg -> 113934
    m = re.search(r"/(\d+)(?:\._[^/]*)?\.\w+$", url)
    return m.group(1) if m else ""


class _WidgetParser(HTMLParser):
    """Collects one dict per `gr_custom_each_container_` block."""

    def __init__(self) -> None:
        super().__init__()
        self.books: list[dict] = []
        self.shelf_link = ""
        self._section = ""
        self._in_author_link = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: v or "" for k, v in attrs}
        if tag == "div":
            cls = a.get("class", "")
            if cls.startswith("gr_custom_each_container"):
                self.books.append({"title": "", "author": "", "review_link": "", "thumbnail": ""})
            self._section = cls
            return
        if tag == "a" and self._section.startswith("gr_custom_container") and not self.shelf_link:
            self.shelf_link = a.get("href", "")
        if not self.books:
            return
        book = self.books[-1]
        if self._section.startswith("gr_custom_book_container"):
            if tag == "a":
                book["title"] = book["title"] or a.get("title", "").strip()
                book["review_link"] = book["review_link"] or a.get("href", "")
            elif tag == "img":
                book["thumbnail"] = book["thumbnail"] or a.get("src", "")
        elif self._section.startswith("gr_custom_author") and tag == "a":
            self._in_author_link = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self._in_author_link = False

    def handle_data(self, data: str) -> None:
        if self._in_author_link and self.books:
            self.books[-1]["author"] += data.strip()


def _fetch_widget(shelf: str, sort: str) -> str:
    # The widget endpoint intermittently answers 500; retry with backoff.
    for attempt in range(1, ATTEMPTS + 1):
        req = urllib.request.Request(_widget_url(shelf, sort), headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == ATTEMPTS:
                raise
        except urllib.error.URLError:
            if attempt == ATTEMPTS:
                raise
        print(f"{shelf}: attempt {attempt} failed, retrying", file=sys.stderr)
        time.sleep(2**attempt)
    raise AssertionError("unreachable")


def fetch_shelf(shelf: str, sort: str) -> list[dict]:
    script = _fetch_widget(shelf, sort)

    parser = _WidgetParser()
    parser.feed(_widget_html(script))

    # Guard against a cached widget for the wrong shelf ever being written.
    if f"shelf={shelf}&" not in parser.shelf_link:
        raise ValueError(f"widget for {shelf!r} returned another shelf: {parser.shelf_link}")

    out: list[dict] = []
    for b in parser.books:
        if not b["title"]:
            continue
        book_id = _book_id_from_cover(b["thumbnail"])
        out.append(
            {
                "title": b["title"],
                "author": b["author"],
                "link": (
                    f"https://www.goodreads.com/book/show/{book_id}"
                    if book_id
                    else b["review_link"].split("?")[0]
                ),
                "thumbnail": b["thumbnail"],
                "book_id": book_id,
            }
        )
    if len(out) >= MAX_BOOKS:
        print(f"warning: {shelf} hit MAX_BOOKS={MAX_BOOKS}; list may be truncated", file=sys.stderr)
    return out


def main() -> int:
    try:
        currently = fetch_shelf("currently-reading", "date_added")
        read = fetch_shelf("read", "date_read")
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if not currently and not read:
        # Both shelves empty almost certainly means the widget changed shape;
        # keep the existing snapshot rather than blanking the site.
        print("error: no books parsed from either shelf; keeping existing snapshot", file=sys.stderr)
        return 1

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "currentlyReading": currently,
        "read": read,
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Wrote {OUT_PATH} ({len(currently)} currently-reading, {len(read)} read)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
