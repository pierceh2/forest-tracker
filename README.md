# Forest tracker

Hourly GitHub Action that loads the Forest browser extension in a real Chromium (under xvfb),
logs in, reads today's planting record, and commits and pushes two files:

- `forest.json` - what your app reads (today's total, resets each day in `America/Los_Angeles`)
- `data/history.json` - per-day totals the script has seen

## Setup

1. Create a GitHub repo and push these files to it.
2. Repo **Settings > Secrets and variables > Actions > New repository secret**, add:
   - `FOREST_EMAIL`
   - `FOREST_PASSWORD`
3. **Settings > Actions > General > Workflow permissions**: set to "Read and write permissions".
4. **Actions** tab > "Forest tracker" > **Run workflow**. Optionally set `backfill_days` (e.g. 30)
   on the first run to fill in past days.
5. Check that `forest.json` appears in the repo. If the run fails or reports unexpected zero
   totals, download the `forest-debug` artifact (screenshot + page text) from the run.

## Reading it from your app

Public repo: `https://raw.githubusercontent.com/<user>/<repo>/main/forest.json`

Private repo: call `https://api.github.com/repos/<user>/<repo>/contents/forest.json` with a
fine-grained token (read-only, Contents) and header `Accept: application/vnd.github.raw+json`.

Example `forest.json`:

```json
{
  "updated_at": "2026-11-03T20:07:41.000Z",
  "timezone": "America/Los_Angeles",
  "date": "2026-11-03",
  "today_minutes": 134,
  "today_hours": 2.23,
  "today_sessions": 2,
  "today_by_tag": { "Study": 134 },
  "tracked_total_minutes": 5120,
  "tracked_total_hours": 85.33,
  "tracked_days": 41
}
```

Check `updated_at` in your app: if it's more than ~2 hours old, the scrape is failing.

## Notes

- `tracked_total_*` only covers days the script has read (today onward, plus any backfill).
  It is not necessarily your all-time Forest total.
- This was written without access to Forest, so the login form selectors and the planting-record
  parser are best guesses based on a screenshot. Expect to tune `ensureLoggedIn` and
  `parseSessions` in `scripts/forest.mjs` after the first run.
- Failed (withered) trees may be counted, since the parser reads text only.
- Config is at the top of the script: extension ID, options page path, timezone.
