from playwright.sync_api import sync_playwright
import os

OUT = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(OUT, exist_ok=True)

PAGES = [
    ("login", "http://127.0.0.1:5174/login"),
    ("overview", "http://127.0.0.1:5174/"),
    ("settings", "http://127.0.0.1:5174/settings"),
    ("help", "http://127.0.0.1:5174/help"),
    ("audit", "http://127.0.0.1:5174/system/audit"),
    ("users", "http://127.0.0.1:5174/system/users"),
    ("status", "http://127.0.0.1:5174/system/status"),
    ("operations", "http://127.0.0.1:5174/system/operations"),
    ("solutions", "http://127.0.0.1:5174/platform/solutions"),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    page = ctx.new_page()
    for name, url in PAGES:
        try:
            page.goto(url, wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(800)
            path = os.path.join(OUT, f"{name}.png")
            page.screenshot(path=path, full_page=True)
            print(f"OK {name} -> {path}")
        except Exception as e:
            print(f"FAIL {name}: {e}")
    browser.close()
