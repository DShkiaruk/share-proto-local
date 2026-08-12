#!/usr/bin/env python3
"""Assemble a shareable prototype project from the template.

Usage: python3 assemble.py <prototype.html> <target-dir>

- copies the template into <target-dir>
- puts the prototype at public/index.html with the comment overlay injected
- ensures viewport-fit=cover so safe-area insets work on iOS
- fills the login page title from the prototype's <title>
"""
import re
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "template"


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: assemble.py <prototype.html> <target-dir>")
    src = Path(sys.argv[1]).expanduser()
    target = Path(sys.argv[2]).expanduser()
    html = src.read_text(encoding="utf-8")
    if target.exists() and any(target.iterdir()):
        sys.exit(f"ERROR: {target} already exists and is not empty")

    shutil.copytree(TEMPLATE, target, dirs_exist_ok=True)

    overlay_tag = '<script src="/overlay.js" defer></script>'
    if "overlay.js" not in html:
        # AI-generated prototypes are often fragment-style (no <body> at all);
        # appending at the end is equivalent — browsers auto-place it in body.
        if "</body>" in html:
            html = html.replace("</body>", f"  {overlay_tag}\n</body>", 1)
        else:
            html = html.rstrip() + f"\n{overlay_tag}\n"

    viewport = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />'
    meta = re.search(r'<meta[^>]*name="viewport"[^>]*>', html)
    if meta and "viewport-fit" not in meta.group(0):
        patched = re.sub(r'content="([^"]*)"', r'content="\1, viewport-fit=cover"', meta.group(0), count=1)
        html = html.replace(meta.group(0), patched, 1)
    elif not meta:
        if "<head>" in html:
            html = html.replace("<head>", f"<head>\n{viewport}", 1)
        else:
            charset = re.search(r'<meta[^>]*charset[^>]*>', html)
            if charset:
                html = html.replace(charset.group(0), charset.group(0) + "\n" + viewport, 1)
            else:
                html = viewport + "\n" + html
    if 'rel="icon"' not in html and "rel='icon'" not in html:
        favicon = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
        html = html.replace(viewport, viewport + "\n" + favicon, 1) if viewport in html else favicon + "\n" + html

    (target / "public" / "index.html").write_text(html, encoding="utf-8")

    m = re.search(r"<title>([^<]{1,60})</title>", html)
    title = (m.group(1).strip() if m else src.stem) or src.stem
    login = target / "public" / "login.html"
    login.write_text(
        login.read_text(encoding="utf-8").replace("{{PROTO_TITLE}}", title),
        encoding="utf-8",
    )
    print(f"OK: assembled at {target} (title: {title})")


if __name__ == "__main__":
    main()
