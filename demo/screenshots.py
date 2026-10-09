#!/usr/bin/env python3
"""Screenshot the static demo (dist/index.html) for the README, with a headless Chromium.

Views are selected through the page's URL hash (#session=, #q=, #only=), so no browser automation library is
needed. Writes docs/screenshots/*.webp when cwebp is available, else PNG.

Browser: $CHROME, else a Playwright-cached chrome-headless-shell, Chrome or Chromium.
Usage: python3 demo/screenshots.py [--html dist/index.html] [--out docs/screenshots]
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANDIDATES = [  # the purpose-built headless shell first; full browsers can stall in --headless (Brave does)
    os.environ.get("CHROME", ""),
    *sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")), reverse=True),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("chromium") or "", shutil.which("google-chrome") or "",
]


def browser():
    for c in CANDIDATES:
        if c and os.path.exists(c):
            return c
    sys.exit("no Chromium-based browser found; set CHROME=/path/to/chrome")


def pick(data):
    """A busy session with PRs and a long thread for the panel shot; a search term with plenty of hits."""
    st = data["state"]
    def score(s):
        return (s["live"] is not None and s["live"]["status"] == "busy", len(s["prs"]), len(data["threads"].get(s["sid"], [])))
    best = max(st["sessions"], key=score)
    return best["sid"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default=os.path.join(ROOT, "dist", "index.html"))
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "screenshots"))
    ap.add_argument("--scale", type=float, default=2)
    a = ap.parse_args()
    html = open(a.html).read()
    data = json.loads(html.split("window.STATIC_DATA = ", 1)[1].split(";</script>", 1)[0].replace("<\\/", "</"))
    sid = pick(data)
    url = "file://" + os.path.abspath(a.html)
    shots = [  # name, hash, width, height, color scheme (0 = dark, 1 = light)
        ("overview", "", 1440, 900, 0),
        ("overview-light", "", 1440, 900, 1),
        ("timeline", "only=sec-timeline", 1440, 1000, 0),
        ("session", f"session={sid}", 1440, 900, 0),
        ("search", "q=cache", 1440, 800, 0),
        ("loose-ends", "only=sec-ends", 1440, 900, 0),
    ]
    os.makedirs(a.out, exist_ok=True)
    chrome, webp = browser(), shutil.which("cwebp")
    with tempfile.TemporaryDirectory() as tmp:
        for name, h, w, ht, scheme in shots:
            png = os.path.join(tmp, name + ".png")
            subprocess.run([chrome, "--headless", f"--screenshot={png}", f"--window-size={w},{ht}", f"--force-device-scale-factor={a.scale}",
                            "--virtual-time-budget=8000", "--hide-scrollbars", f"--blink-settings=preferredColorScheme={scheme}",
                            f"--user-data-dir={os.path.join(tmp, 'profile-' + name)}", url + ("#" + h if h else "")],  # fresh profile per shot: no recent strip carried over
                           # not capture_output: Chromium's helper processes inherit the pipes and keep them open
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
            if webp:
                dst = os.path.join(a.out, name + ".webp")
                subprocess.run([webp, "-quiet", "-q", "86", png, "-o", dst], check=True)
            else:
                dst = os.path.join(a.out, name + ".png")
                shutil.copy(png, dst)
            print(f"{dst}  {os.path.getsize(dst) // 1024} KB")


if __name__ == "__main__":
    main()
