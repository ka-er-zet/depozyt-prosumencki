#!/usr/bin/env python3
"""
update_rcem.py

Scrapes RCEm table from PSE and writes `rcem.json` with structure:
{
  "2025": {"1": 480.01, "2": ...},
  "2024": {...}
}

Designed to run in GitHub Actions monthly. Commits only if file changed.
"""
import requests
from bs4 import BeautifulSoup
import re
import json
from pathlib import Path
from datetime import datetime

URL = 'https://www.pse.pl/oire/rcem-rynkowa-miesieczna-cena-energii-elektrycznej'
OUT_FILE = Path(__file__).parent / 'rcem.json'
CHANGES_FILE = Path(__file__).parent / 'rcem_changes.txt'

MONTH_MAP = {
    'styczeń': 1, 'styczenia':1, 'stycznia':1,
    'luty': 2, 'lutego':2,
    'marzec': 3, 'marca':3,
    'kwiecień': 4, 'kwietnia':4,
    'maj': 5, 'maja':5,
    'czerwiec': 6, 'czerwca':6,
    'lipiec': 7, 'lipca':7,
    'sierpień': 8, 'sierpnia':8,
    'wrzesień': 9, 'września':9,
    'październik': 10, 'października':10,
    'listopad': 11, 'listopada':11,
    'grudzień': 12, 'grudnia':12
}

def text_to_number(s):
    if s is None:
        return None
    s = s.strip()
    if s == '':
        return None
    # remove non-number characters except comma and dot
    s = re.sub(r"[^0-9,.-]", '', s)
    s = s.replace(',', '.')
    try:
        return float(s)
    except Exception:
        return None


def parse_date(s):
    """Parse date in format dd.mm.yyyy or return None for '-' or empty."""
    if not s:
        return None
    s = s.strip()
    if s == '-' or s == '':
        return None
    # sometimes there might be time or other chars; extract dd.mm.yyyy
    m = re.search(r"(\d{1,2}\.\d{1,2}\.\d{4})", s)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), '%d.%m.%Y').date()
    except Exception:
        return None

def scrape():
    headers = {'User-Agent': 'rcem-updater/1.0 (+https://github.com)'}
    resp = requests.get(URL, headers=headers, timeout=15)
    resp.raise_for_status()

    return parse_html(resp.text)


def parse_html(html_text):
    """Parse HTML and return dict like { '2025': { '1': 480.01, ... }, ... }

    Also uses publication dates to prefer corrected values only when correction
    publication date is later than original RCEm publication.
    """
    soup = BeautifulSoup(html_text, 'lxml')
    results = {}

    tables = soup.find_all('table')
    for table in tables:
        rows = table.find_all('tr')
        if not rows:
            continue
        year = None
        for r in rows[:4]:
            for cell in r.find_all(['th', 'td']):
                txt = cell.get_text(strip=True)
                if re.match(r'^\d{4}$', txt):
                    year = txt
                    break
            if year:
                break
        if not year:
            continue

        i = 0
        while i < len(rows):
            tr = rows[i]
            cols = [c.get_text(strip=True) for c in tr.find_all(['td', 'th'])]
            if not cols:
                i += 1
                continue
            first = cols[0].lower()
            month_found = None
            for k in MONTH_MAP.keys():
                if k in first:
                    month_found = MONTH_MAP[k]
                    break
            if month_found:
                # immediate next row should be RCEm (if present)
                rcem_val = None
                rcem_date = None
                skoryg_list = []  # list of tuples (val, date)
                next_idx = i + 1
                if next_idx < len(rows):
                    row_next = rows[next_idx]
                    cells_next = [c.get_text(strip=True) for c in row_next.find_all(['td', 'th'])]
                    if cells_next:
                        lbl = cells_next[0].lower()
                        if 'rcem' in lbl:
                            if len(cells_next) > 1:
                                rcem_val = text_to_number(cells_next[1])
                            if len(cells_next) > 2:
                                rcem_date = parse_date(cells_next[2])
                    # collect following skorygowana rows until next month occurs
                    m = next_idx + 1
                    while m < len(rows):
                        rowm = rows[m]
                        cellsm = [c.get_text(strip=True) for c in rowm.find_all(['td', 'th'])]
                        if not cellsm:
                            m += 1
                            continue
                        first_cell = cellsm[0].lower()
                        # stop on next month
                        if any(k in first_cell for k in MONTH_MAP.keys()):
                            break
                        if 'skorygowana' in first_cell and 'rcem' in first_cell:
                            val = None
                            date = None
                            if len(cellsm) > 1:
                                val = text_to_number(cellsm[1])
                            if len(cellsm) > 2:
                                date = parse_date(cellsm[2])
                            if val is not None:
                                skoryg_list.append((val, date))
                        m += 1

                # decide which value to use
                chosen = None
                if skoryg_list:
                    # prefer a correction whose date is later than base rcem_date
                    # find corrections with date > rcem_date
                    later_corr = []
                    for val, date in skoryg_list:
                        if date and rcem_date:
                            if date > rcem_date:
                                later_corr.append((date, val))
                        elif date and not rcem_date:
                            # no base date, accept correction
                            later_corr.append((date, val))
                        else:
                            # no date info - keep as fallback
                            later_corr.append((date, val))
                    if later_corr:
                        # choose correction with the latest date (or last if dates missing)
                        later_corr.sort()
                        chosen = later_corr[-1][1]
                if chosen is None and rcem_val is not None:
                    chosen = rcem_val

                if chosen is not None:
                    chosen = round(chosen, 2)
                    results.setdefault(year, {})[str(month_found)] = chosen
                i += 1
                continue
            i += 1

    return results

def main():
    print('Scraping RCEm from PSE...')
    try:
        new = scrape()
    except Exception as e:
        print('Error scraping:', e)
        raise

    if not new:
        print('No data parsed from page.')
        return 1

    # If file exists, compare and update only if different
    if OUT_FILE.exists():
        old = json.loads(OUT_FILE.read_text(encoding='utf-8'))
    else:
        old = {}

    if old == new:
        print('No changes in RCEm data.')
        return 0
    # compute changes for logging
    changes = []
    years = sorted(set(list(old.keys()) + list(new.keys())))
    for y in years:
        old_year = old.get(y, {})
        new_year = new.get(y, {})
        months = sorted(set(list(old_year.keys()) + list(new_year.keys())), key=lambda x: int(x))
        for m in months:
            o = old_year.get(m)
            n = new_year.get(m)
            if o != n:
                changes.append((y, m, o, n))

    OUT_FILE.write_text(json.dumps(new, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Wrote {OUT_FILE} with {sum(len(v) for v in new.values())} entries')

    if changes:
        with CHANGES_FILE.open('w', encoding='utf-8') as fh:
            for y, m, o, n in changes:
                fh.write(f"{y}-{m}: {o} -> {n}\n")
        print(f'Wrote changes log to {CHANGES_FILE} ({len(changes)} items)')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
