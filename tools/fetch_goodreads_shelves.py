#!/usr/bin/env python3
"""
Fetch Goodreads shelf RSS server-side (no CORS) and write js/books-data.json
for the static site. Re-run after your shelves change, or wire this into CI.

  python3 tools/fetch_goodreads_shelves.py
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

GOODREADS_USER_ID = "185559715"
RSS_PAGE_SIZE = 100
MAX_SHELF_PAGES = 30
OUT_PATH = "js/books-data.json"
UA = "Mozilla/5.0 (compatible; mooga-books-fetch/1.0; +https://m-mooga.com)"


def _shelf_rss_url(shelf: str, page: int) -> str:
    from urllib.parse import quote

    return (
        f"https://www.goodreads.com/review/list_rss/{GOODREADS_USER_ID}"
        f"?shelf={quote(shelf)}&per_page={RSS_PAGE_SIZE}&page={page}"
    )


def _first_text(parent: ET.Element, tag: str) -> str:
    el = parent.find(tag)
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def _parse_items(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    channel = root.find("channel")
    if channel is None:
        return []
    out: list[dict] = []
    for item in channel.findall("item"):
        desc = _first_text(item, "description")
        thumb = (
            _first_text(item, "book_medium_image_url")
            or _first_text(item, "book_image_url")
            or _first_text(item, "book_small_image_url")
        )
        out.append(
            {
                "title": _first_text(item, "title"),
                "link": _first_text(item, "link"),
                "pubDate": _first_text(item, "pubDate"),
                "thumbnail": thumb,
                "description": desc,
                "content": desc,
                "book_id": _first_text(item, "book_id"),
            }
        )
    return out


def _fetch_xml(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def fetch_shelf_all_pages(shelf: str) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for page in range(1, MAX_SHELF_PAGES + 1):
        url = _shelf_rss_url(shelf, page)
        try:
            raw = _fetch_xml(url)
        except urllib.error.HTTPError as e:
            if page == 1:
                raise
            break
        except urllib.error.URLError:
            if page == 1:
                raise
            break
        items = _parse_items(raw)
        if not items:
            break
        for b in items:
            bid = b.get("book_id") or b.get("link") or b.get("title") or ""
            if bid in seen:
                continue
            seen.add(bid)
            merged.append(b)
        if len(items) < RSS_PAGE_SIZE:
            break
    return merged


def main() -> int:
    try:
        currently = fetch_shelf_all_pages("currently-reading")
        read = fetch_shelf_all_pages("read")
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
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
