#!/usr/bin/env python3
"""
Fetch hourly RCE prices from PSE and maintain a local `rce.json` file keyed by ISO datetime.

This script can backfill from 2004-07-01 and will append new hours when run daily.

Output format (rce.json):
{
  "2004-07-01T00:00:00": 0.0123,
  "2004-07-01T00:15:00": 0.0000,
  ...
}

Prices are stored in PLN/kWh (converted from zł/MWh by dividing by 1000).
Negative prices are clamped to 0.
"""
from __future__ import annotations
import requests
import json
from datetime import datetime, date, timedelta
from pathlib import Path
import sys

API_BASE = 'https://api.raporty.pse.pl/api/rce-pln'
OUT_FILE = Path(__file__).parent / 'rce.json'

DEFAULT_START = date(2004, 7, 1)


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def load_existing() -> dict:
    if OUT_FILE.exists():
        try:
            return json.loads(OUT_FILE.read_text())
        except Exception:
            return {}
    return {}


def save(data: dict):
    tmp = OUT_FILE.with_suffix('.tmp.json')
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(OUT_FILE)


def fetch_range(start: date, end: date) -> list:
    # fetch business_date ge start and lt end (end exclusive)
    fmt = lambda d: d.isoformat()
    url = f"{API_BASE}?$filter=business_date ge '{fmt(start)}' and business_date lt '{fmt(end)}'"
    all_items = []
    while url:
        resp = requests.get(url, headers={'Accept': 'application/json'})
        resp.raise_for_status()
        j = resp.json()
        if j.get('value'):
            all_items.extend(j['value'])
        url = j.get('nextLink')
    return all_items


def item_to_kv(item):
    # Convert item to (iso, price_pln_kwh)
    dtime = item.get('dtime', '')
    # remove trailing letters like 'a'/'b'
    dtime = dtime.replace('a', '').replace('b', '')
    try:
        dt = datetime.fromisoformat(dtime)
    except Exception:
        # try space-separated
        dt = datetime.strptime(dtime, '%Y-%m-%d %H:%M:%S')
    price = max(0, item.get('rce_pln', 0) / 1000.0)
    return iso(dt), price


def daterange_chunks(start: date, end: date, chunk_days=30):
    cur = start
    while cur < end:
        nxt = min(end, cur + timedelta(days=chunk_days))
        yield cur, nxt
        cur = nxt


def main(start_date: date | None = None, end_date: date | None = None):
    existing = load_existing()
    if start_date is None:
        # determine earliest needed: default start or earliest missing from existing
        start_date = DEFAULT_START
    if end_date is None:
        end_date = date.today()

    # If existing has entries, we can skip already present hours
    # We'll fetch in chunks from start_date to end_date but only insert keys not present
    added = 0
    for s, e in daterange_chunks(start_date, end_date, chunk_days=30):
        try:
            items = fetch_range(s, e)
        except Exception as exc:
            print(f'Error fetching {s}..{e}:', exc)
            continue
        for it in items:
            k, v = item_to_kv(it)
            if k not in existing:
                existing[k] = round(v, 6)
                added += 1

    # sort keys
    if added > 0:
        sorted_obj = {k: existing[k] for k in sorted(existing.keys())}
        save(sorted_obj)
        print(f'Appended {added} hourly entries to {OUT_FILE.name}')
        # write short changes log
        changelog = Path(__file__).parent / 'rce_changes.txt'
        # use timezone-aware UTC timestamp
        from datetime import timezone
        changelog.write_text(f'Appended {added} entries on {datetime.now(timezone.utc).isoformat()}\n')
    else:
        print('No new hourly entries to append.')


if __name__ == '__main__':
    # optional args: start_date end_date in YYYY-MM-DD
    sd = None
    ed = None
    if len(sys.argv) >= 2:
        sd = datetime.strptime(sys.argv[1], '%Y-%m-%d').date()
    if len(sys.argv) >= 3:
        ed = datetime.strptime(sys.argv[2], '%Y-%m-%d').date()
    main(sd, ed)
