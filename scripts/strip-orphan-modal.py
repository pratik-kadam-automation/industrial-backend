#!/usr/bin/env python3
"""
strip-orphan-modal.py — remove the unreachable downtime-config modal that
was hand-added to index.html, while keeping the Certificates nav link
(which belongs there and works correctly).

The modal has no trigger button anywhere on the page, uses a fake
x-username header instead of the real session cookie, and is styled
with hardcoded colors instead of the dashboard's theme variables. The
same feature is being rebuilt properly inside the authenticated /certs
admin panel instead.

Idempotent: if the marker comment is not found, does nothing and exits 0.
"""
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "index.html"
START_MARK = "<!-- DOWNTIME TAG CONFIGURATION MODAL -->"

with open(PATH, encoding="utf-8") as f:
    text = f.read()

start = text.find(START_MARK)
if start == -1:
    print("No orphaned modal found — nothing to do.")
    sys.exit(0)

head = text[:start].rstrip("\n") + "\n"

script_end_marker = "</script>"
end = text.find(script_end_marker, start)
if end == -1:
    print("ERROR: found the modal start but not its closing </script> — aborting untouched.", file=sys.stderr)
    sys.exit(1)
end += len(script_end_marker)

tail = text[end:]
tail = tail.replace("</body>\n\n</html>", "</body>\n</html>")

new_text = head + tail.lstrip("\n")

with open(PATH, "w", encoding="utf-8") as f:
    f.write(new_text)

removed = end - start
print(f"Removed {removed} chars (the orphaned modal). Certificates nav link untouched.")
