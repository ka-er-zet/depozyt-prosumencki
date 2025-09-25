RCE hourly backfill

This repository includes `update_rce.py` which maintains `rce.json` containing hourly RCE prices (PLN/kWh) keyed by ISO datetime.

To backfill locally from 2004-07-01 to today:

```bash
python update_rce.py 2004-07-01 $(date +%F)
```

To fetch a specific range:

```bash
python update_rce.py 2024-01-01 2024-01-31
```

On GitHub Actions `/.github/workflows/update-rce.yml` runs daily and will append new hours to `rce.json` and commit changes.
