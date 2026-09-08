# -*- coding: utf-8 -*-
"""
archive_recordings.py
==================================================
Downloads all call recordings and voicemails older than a configurable
cutoff to local storage, named:

    <campaign>_<direction>_<agent name>_<yyyymmdd>.wav

Talks to the backend's new /archive/eligible and /archive/confirm
routes (see backend/routes/archiveRoutes.js) — those routes do the
actual database querying and generate short-lived presigned S3
download URLs; this script just calls them and streams each file to
disk. Nothing on the server gets deleted or modified by this script
beyond marking each successfully-downloaded recording as "archived"
(a separate tracking table, cmx_dialer.archived_recordings) so a
scheduled daily run never re-downloads the same file twice.

Designed to run two ways:
  1. Interactively in Spyder — run cell by cell (the "# %%" markers
     below) to inspect ELIGIBLE_ITEMS / RESULTS in the Variable
     Explorer as you go, or just hit Run File (F5) to do everything
     in one pass.
  2. Unattended, later, via a scheduled .bat file calling
     `python archive_recordings.py` — every print() below also works
     fine redirected to a log file.
==================================================
"""

import os
from datetime import date, timedelta

import requests

# %% ================= CONFIG =================

# --- Server connection ---
API_BASE_URL = "https://your-server-domain-or-ip:PORT"  # TODO: fill in your real server address
ARCHIVE_SECRET = "REPLACE_WITH_ARCHIVE_API_SECRET"  # must match ARCHIVE_API_SECRET in backend/.env

# --- Where files get saved on this PC ---
LOCAL_STORAGE_DIR = r"C:\CMXRecordingsArchive"  # TODO: point this at wherever you want files kept

# --- How far back to reach ---
DAYS_THRESHOLD = 5

# --- PROD vs TEST reference date ---
# Flip this to True to test against a specific historical date instead
# of "today" — useful for confirming the script grabs the right window
# of calls without needing to wait for real time to pass. Leave False
# for actual production runs.
USE_TEST_DATE = False
TEST_REFERENCE_DATE = date(2026, 1, 15)  # only used when USE_TEST_DATE = True


def get_reference_date():
    """'Now', for the purposes of this script — either the real
    today (prod) or a fixed stand-in date (testing), controlled by
    USE_TEST_DATE above."""
    return TEST_REFERENCE_DATE if USE_TEST_DATE else date.today()


def get_cutoff_date():
    """Anything with a call/voicemail date strictly before this is
    eligible to archive."""
    return get_reference_date() - timedelta(days=DAYS_THRESHOLD)


# %% ================= HELPERS =================


def log(message):
    print(f"[{date.today().isoformat()}] {message}")


def fetch_eligible_items(cutoff_date):
    """Calls GET /archive/eligible and returns the list of items."""
    url = f"{API_BASE_URL}/archive/eligible"
    params = {"secret": ARCHIVE_SECRET, "olderThanDate": cutoff_date.isoformat()}
    response = requests.get(url, params=params, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("success"):
        raise RuntimeError(f"/archive/eligible returned success=false: {data.get('message')}")
    return data["items"]


def confirm_archived(recording_keys):
    """Calls POST /archive/confirm for one or more recording keys
    that have already finished downloading successfully."""
    if not recording_keys:
        return
    url = f"{API_BASE_URL}/archive/confirm"
    response = requests.post(
        url,
        json={"secret": ARCHIVE_SECRET, "recordingKeys": recording_keys},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if not data.get("success"):
        raise RuntimeError(f"/archive/confirm returned success=false: {data.get('message')}")


def unique_local_path(directory, filename_base, extension=".wav"):
    """Appends _2, _3, ... if filename_base.wav already exists on
    disk — handles two calls landing on the identical
    campaign/direction/agent/day combination without one overwriting
    the other. The backend already guarantees a sensible base name;
    this is purely about what's ALREADY sitting in this folder from a
    previous run or a genuine same-day collision."""
    candidate = os.path.join(directory, f"{filename_base}{extension}")
    if not os.path.exists(candidate):
        return candidate

    counter = 2
    while True:
        candidate = os.path.join(directory, f"{filename_base}_{counter}{extension}")
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def download_item(item, storage_dir):
    """Streams one item's audio file to disk. Returns the local path
    on success, or None on failure (logged, not raised — one bad file
    shouldn't stop the whole run)."""
    local_path = unique_local_path(storage_dir, item["suggestedFilename"])
    try:
        with requests.get(item["downloadUrl"], stream=True, timeout=60) as response:
            response.raise_for_status()
            with open(local_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    if chunk:
                        f.write(chunk)
        return local_path
    except Exception as exc:
        log(f"  FAILED to download {item['recordingKey']}: {exc}")
        # Clean up a partial file rather than leaving a truncated .wav behind.
        if os.path.exists(local_path):
            os.remove(local_path)
        return None


# %% ================= MAIN =================


def main():
    os.makedirs(LOCAL_STORAGE_DIR, exist_ok=True)

    cutoff = get_cutoff_date()
    mode = "TEST" if USE_TEST_DATE else "PROD"
    log(f"Mode: {mode} | Reference date: {get_reference_date()} | Cutoff (older than): {cutoff}")

    items = fetch_eligible_items(cutoff)
    log(f"Found {len(items)} recording(s)/voicemail(s) eligible for archiving.")

    if not items:
        log("Nothing to do.")
        return []

    results = []
    for i, item in enumerate(items, start=1):
        log(
            f"[{i}/{len(items)}] {item['direction']} | {item['campaignName'] or item['campaignId']} "
            f"| {item['agentName']} | {item['callStartedAt']}"
        )
        local_path = download_item(item, LOCAL_STORAGE_DIR)
        if local_path:
            log(f"  Saved to {local_path}")
            # Confirmed immediately after each successful download —
            # if the script crashes partway through a big run, whatever
            # already succeeded won't be re-downloaded next time.
            confirm_archived([item["recordingKey"]])
            results.append({"item": item, "localPath": local_path, "success": True})
        else:
            results.append({"item": item, "localPath": None, "success": False})

    succeeded = sum(1 for r in results if r["success"])
    failed = len(results) - succeeded
    log(f"Done. {succeeded} archived successfully, {failed} failed.")
    return results


# %% ================= RUN =================

if __name__ == "__main__":
    RESULTS = main()
