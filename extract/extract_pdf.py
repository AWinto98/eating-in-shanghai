"""Extract restaurant entries from the saintcavish Shanghai guide PDF.

The guide has two structures we exploit:

  * body pages -- 60pt spans are cuisine section dividers, 16pt text is the
    prose. Restaurant names are always bold inside that prose, either as a
    standalone heading followed by its notes, or bolded inline mid-sentence
    in a paragraph that lists several places.
  * directory  -- the final pages list every restaurant as a 3-line record:
    English name / Chinese name + Chinese address / English address gloss.

The directory is the authoritative roster. Bold text in the body is only
accepted as a restaurant when it matches a directory name, so sub-headers and
intro paragraphs never leak in as fake entries. Anything that does not join
cleanly is flagged for manual review rather than guessed at.

Usage:
    python extract/extract_pdf.py [--pdf PATH] [--out-dir data]
"""

import argparse
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

import pymupdf

BODY_SIZE = 16.0
CUISINE_DIVIDER_RANGE = (50.0, 66.0)
FRONT_MATTER_RANGE = (22.0, 26.0)
CHROME_SIZE = 10.0

# Ideographs plus the radical blocks the subsetted fonts emit.
CJK = re.compile(r"[⺀-⿟㐀-䶿一-鿿豈-﫿]")
SEPARATORS = {",", "，"}

OTHER_CITIES = ("Suzhou", "Hangzhou")

# NFKC folds the Kangxi Radicals block but not CJK Radicals Supplement, and the
# subsetted fonts emit both where unified ideographs are meant. Left alone these
# silently break geocoding.
RADICALS = {
    "⻄": "西", "⻩": "黄", "⻥": "鱼", "⻰": "龙", "⻬": "齐",
    "⺠": "民", "⻢": "马", "⻛": "风", "⻔": "门", "⻝": "食",
}
RADICAL_BLOCKS = re.compile(r"[⺀-⻿⼀-⿟]")

unmapped_radicals = set()


def norm_cn(text):
    text = unicodedata.normalize("NFKC", text).strip()
    text = "".join(RADICALS.get(ch, ch) for ch in text)
    unmapped_radicals.update(RADICAL_BLOCKS.findall(text))
    return text


def norm_key(name):
    """Normalized form used to join body names to directory entries."""
    s = unicodedata.normalize("NFKC", name).lower()
    s = s.replace("’", "'").replace("‘", "'")
    s = s.strip().rstrip("*").strip()
    s = re.sub(r"^the\s+", "", s)
    s = re.sub(r"[^a-z0-9']+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "unnamed"


def sorted_text_blocks(page):
    blocks = [b for b in page.get_text("dict")["blocks"] if b["type"] == 0]
    blocks.sort(key=lambda b: (round(b["bbox"][1], 1), round(b["bbox"][0], 1)))
    return blocks


def body_block(block):
    """Flatten a block's 16pt spans into text plus the offsets of bold runs.

    Returns None if the block has no body-size text. A space is inserted at
    bold/regular boundaries that lost theirs to the PDF's link spans.
    """
    parts = []
    runs = []
    line_ends = set()
    pos = 0
    for li, line in enumerate(block["lines"]):
        spans = [
            s
            for s in line["spans"]
            if s["text"].strip() and abs(s["size"] - BODY_SIZE) <= 0.5
        ]
        if not spans:
            continue
        if parts:
            line_ends.add(pos)
            parts.append(" ")
            pos += 1
        for s in spans:
            bold = "Bold" in s["font"]
            text = s["text"]
            if parts and runs and runs[-1][2] != bold:
                if not parts[-1].endswith(" ") and not text.startswith(" "):
                    parts.append(" ")
                    pos += 1
            runs.append((pos, pos + len(text), bold))
            parts.append(text)
            pos += len(text)
    if not parts:
        return None

    text = "".join(parts)
    line_ends.add(len(text))
    bolds = []
    for start, end, bold in runs:
        if not bold:
            continue
        if bolds and text[bolds[-1][1]:start].strip() == "":
            bolds[-1][1] = end
        else:
            bolds.append([start, end])
    return {
        "text": text,
        # A bold run that starts the block and ends a line is a standalone
        # heading; one that ends mid-line is a name bolded inside a sentence.
        "bolds": [(s, e, s == 0 and e in line_ends) for s, e in bolds],
        "bbox": block["bbox"],
    }


def find_sections(doc):
    """Cuisine dividers (60pt) and front-matter headers (24pt), in page order."""
    sections = []
    for pno, page in enumerate(doc):
        for block in sorted_text_blocks(page):
            for line in block["lines"]:
                for s in line["spans"]:
                    text = s["text"].strip()
                    if not text:
                        continue
                    lo, hi = CUISINE_DIVIDER_RANGE
                    if lo <= s["size"] <= hi:
                        sections.append((pno, text, "cuisine"))
                    else:
                        lo, hi = FRONT_MATTER_RANGE
                        if lo <= s["size"] <= hi:
                            sections.append((pno, text, "front_matter"))
    return sections


def line_text(spans):
    return "".join(s["text"] for s in spans).strip()


def find_directory_start(doc, after_page):
    for pno in range(after_page + 1, doc.page_count):
        cn_lines = sum(
            1
            for block in sorted_text_blocks(doc[pno])
            for line in block["lines"]
            if CJK.search("".join(s["text"] for s in line["spans"]))
        )
        if cn_lines >= 3:
            return pno
    return None


def parse_directory(doc, start_page):
    """Parse the address directory. Records are 3 lines, anchored on the CN line.

    The CN line reads "<chinese name>, <chinese address>"; the comma arrives as
    its own span, which is more reliable than the font (the 2026 additions were
    typeset in a different CJK face than the rest of the directory).
    """
    records = []
    group = None
    for pno in range(start_page, doc.page_count):
        lines = []
        for block in sorted_text_blocks(doc[pno]):
            for line in block["lines"]:
                spans = [s for s in line["spans"] if s["text"].strip()]
                if spans and max(s["size"] for s in spans) >= CHROME_SIZE:
                    lines.append(spans)

        def has_cn(idx):
            return 0 <= idx < len(lines) and bool(CJK.search(line_text(lines[idx])))

        for idx, spans in enumerate(lines):
            text = line_text(spans)
            if not has_cn(idx):
                # A bold line between records is a group header for what follows.
                if all("Bold" in s["font"] for s in spans):
                    group = text
                continue

            split = next(
                (i for i, s in enumerate(spans) if s["text"].strip() in SEPARATORS),
                len(spans),
            )
            cn_name = norm_cn(line_text(spans[:split]))
            address_cn = norm_cn(line_text(spans[split + 1:]))

            name_en = line_text(lines[idx - 1]) if idx else ""
            if has_cn(idx - 1):
                name_en = ""
            address_en = (
                line_text(lines[idx + 1])
                if idx + 1 < len(lines) and not has_cn(idx + 1)
                else ""
            )

            city = "Shanghai"
            for other in OTHER_CITIES:
                if address_en.startswith(other + ","):
                    city = other
                    address_en = address_en[len(other) + 1:].strip()

            records.append(
                {
                    "name_en": name_en.rstrip("*").strip(),
                    "name_cn": cn_name,
                    "address_cn": address_cn,
                    "address_en": address_en,
                    "city": city,
                    "multiple_locations": name_en.endswith("*"),
                    "directory_group": group,
                    "directory_page": pno + 1,
                }
            )
    return records


class Roster:
    """Directory names, matchable by exact key, de-spaced key, or substring."""

    def __init__(self, records):
        self.by_key = {}
        self.by_squashed = {}
        self.by_length = []
        for rec in records:
            if not rec["name_en"]:
                continue
            key = norm_key(rec["name_en"])
            self.by_key.setdefault(key, key)
            self.by_squashed.setdefault(key.replace(" ", ""), key)
            self.by_length.append(key)
        self.by_length.sort(key=len, reverse=True)

    def match(self, text):
        key = norm_key(text)
        if key in self.by_key:
            return key
        return self.by_squashed.get(key.replace(" ", ""))

    def find_in(self, text):
        """Longest roster name occurring as a substring, for unbolded mentions."""
        haystack = norm_key(text)
        for key in self.by_length:
            if len(key) >= 12 and key in haystack:
                return key, haystack.index(key)
        return None


def parse_body(doc, roster, sections, directory_start):
    """Collect notes, categories and Dianping links for every roster name."""
    section_at = {}
    for pno, title, kind in sections:
        section_at.setdefault(pno, (title, kind))

    entries = {}
    intros = {}
    leftovers = []
    section = None
    kind = None
    current = None

    def note(key, text, pno):
        text = text.strip()
        if not text:
            return
        entry = entries.setdefault(
            key, {"notes": [], "links": [], "page": pno + 1, "section": section,
                  "section_kind": kind}
        )
        entry["notes"].append(text)

    for pno in range(directory_start):
        page = doc[pno]
        if pno in section_at:
            section, kind = section_at[pno]
            current = None

        blocks = [b for b in (body_block(b) for b in sorted_text_blocks(page)) if b]
        if not blocks:
            current = None  # full-bleed photo page ends the previous entry
            continue
        if section is None:
            continue

        links = [
            (lk["from"].y0, lk["uri"]) for lk in page.get_links() if lk.get("uri")
        ]
        owners = [(-1.0, current)] if current else []

        for block in blocks:
            text = block["text"]
            hits = []
            for start, end, heading in block["bolds"]:
                key = roster.match(text[start:end])
                if key:
                    hits.append((start, end, heading, key))
            if not hits:
                found = roster.find_in(text)
                if found:
                    hits.append((0, 0, False, found[0]))

            if hits:
                for i, (start, end, heading, key) in enumerate(hits):
                    # A heading is redundant with the name; an inline mention is
                    # part of the sentence, and keeps the lead-in before it.
                    begin = end if heading else (0 if i == 0 else start)
                    stop = hits[i + 1][0] if i + 1 < len(hits) else len(text)
                    entries.setdefault(
                        key,
                        {"notes": [], "links": [], "page": pno + 1,
                         "section": section, "section_kind": kind},
                    )
                    note(key, text[begin:stop], pno)
                current = hits[-1][3]
            elif block["bolds"]:
                # Bold text matching nothing in the roster starts a new topic.
                current = None
                intros.setdefault(section, []).append(text)
            elif current:
                note(current, text, pno)
            else:
                intros.setdefault(section, []).append(text)
                if kind == "cuisine":
                    leftovers.append({"page": pno + 1, "section": section, "text": text})

            owner = hits[-1][3] if hits else current
            if owner:
                owners.append((block["bbox"][1], owner))

        # A "(Details)" link can sit in its own 12pt block, so attribute every
        # link to the last entry that owns text above it.
        for ly, uri in links:
            owner = next(
                (k for y, k in reversed(owners) if y <= ly + 2), None
            )
            if owner:
                entries[owner]["links"].append(uri)

    return entries, intros, leftovers


def clean_notes(parts):
    text = " ".join(p.strip() for p in parts if p.strip())
    text = re.sub(r"\s*\(\s*Details\s*\)\s*", " ", text)
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def build_records(roster_records, entries):
    out = []
    seen = {}
    for rec in roster_records:
        key = norm_key(rec["name_en"]) if rec["name_en"] else None
        body = entries.get(key)
        flags = []

        if not rec["name_en"]:
            flags.append("missing_name_en")
        if not rec["address_cn"]:
            flags.append("missing_address_cn")
        if not rec["address_en"]:
            flags.append("missing_address_en")
        if body is None:
            flags.append("no_body_entry")

        category = None
        if body:
            if body["section_kind"] == "cuisine":
                category = body["section"]
            else:
                category = rec["directory_group"] or body["section"]
                flags.append("category_from_front_matter")

        notes = clean_notes(body["notes"]) if body else ""
        if body and not notes:
            flags.append("empty_notes")

        links = body["links"] if body else []
        dianping = next((u for u in links if "dianping.com" in u), None)
        if body and not dianping:
            flags.append("no_dianping_link")

        base = slugify(rec["name_en"] or rec["name_cn"])
        seen[base] = seen.get(base, 0) + 1
        rid = base if seen[base] == 1 else f"{base}-{seen[base]}"

        out.append(
            {
                "id": rid,
                "name_en": rec["name_en"],
                "name_cn": rec["name_cn"],
                "address_cn": rec["address_cn"],
                "address_en": rec["address_en"],
                "city": rec["city"],
                "category": category,
                "notes": notes,
                "dianping_url": dianping,
                "other_links": sorted({u for u in links if u != dianping}),
                "multiple_locations": rec["multiple_locations"],
                "source": {
                    "directory_page": rec["directory_page"],
                    "entry_page": body["page"] if body else None,
                },
                "flags": flags,
            }
        )
    return out


def write_csv(path, records):
    cols = [
        "id", "name_en", "name_cn", "address_cn", "address_en", "city",
        "category", "multiple_locations", "dianping_url", "notes", "flags",
    ]
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        for rec in records:
            row = dict(rec)
            row["flags"] = ";".join(rec["flags"])
            writer.writerow(row)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default="saintcavish guide to eating in shanghai 2026.pdf")
    ap.add_argument("--out-dir", default="data")
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        sys.exit(f"PDF not found: {pdf_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = pymupdf.open(pdf_path)
    sections = find_sections(doc)
    cuisines = [s for s in sections if s[2] == "cuisine"]
    if not cuisines:
        sys.exit("No section dividers found - the PDF layout may have changed.")

    directory_start = find_directory_start(doc, cuisines[-1][0])
    if directory_start is None:
        sys.exit("No address directory found - the PDF layout may have changed.")

    roster_records = parse_directory(doc, directory_start)
    roster = Roster(roster_records)
    entries, intros, leftovers = parse_body(doc, roster, sections, directory_start)
    records = build_records(roster_records, entries)

    matched = {norm_key(r["name_en"]) for r in roster_records if r["name_en"]}
    orphans = sorted(k for k in entries if k not in matched)

    categories = sorted({r["category"] for r in records if r["category"]})
    payload = {
        "source_pdf": pdf_path.name,
        "categories": categories,
        "section_intros": {
            title: clean_notes(v)
            for title, v in intros.items()
            if any(title == s[1] and s[2] == "cuisine" for s in sections)
        },
        "restaurants": records,
    }
    (out_dir / "restaurants.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    write_csv(out_dir / "restaurants.csv", records)

    review = {
        "flagged_restaurants": [
            {"id": r["id"], "name_en": r["name_en"], "flags": r["flags"],
             "directory_page": r["source"]["directory_page"]}
            for r in records if r["flags"]
        ],
        "body_text_not_attributed": leftovers,
        "body_names_not_in_directory": orphans,
    }
    (out_dir / "review_queue.json").write_text(
        json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"pages              {doc.page_count}")
    print(f"cuisine sections   {len(cuisines)}  ({', '.join(t for _, t, _ in cuisines)})")
    print(f"directory starts   p{directory_start + 1}")
    print(f"restaurants        {len(records)}")
    print(f"  with notes       {sum(1 for r in records if r['notes'])}")
    print(f"  with category    {sum(1 for r in records if r['category'])}")
    print(f"  with address     {sum(1 for r in records if r['address_cn'])}")
    print(f"  with dianping    {sum(1 for r in records if r['dianping_url'])}")
    print(f"  outside Shanghai {sum(1 for r in records if r['city'] != 'Shanghai')}")
    if unmapped_radicals:
        print(f"WARNING unmapped CJK radicals in output: {sorted(unmapped_radicals)}"
              " - add them to RADICALS or geocoding will fail")
    print(f"flagged for review {len(review['flagged_restaurants'])}"
          f"  -> {out_dir / 'review_queue.json'}")
    print(f"wrote              {out_dir / 'restaurants.json'}")
    print(f"wrote              {out_dir / 'restaurants.csv'}")


if __name__ == "__main__":
    main()
