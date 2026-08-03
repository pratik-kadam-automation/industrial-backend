#!/usr/bin/env bash
#
# patch-certs-nav.sh — add a "Certificates" link to the dashboard sidebar.
#
# The link is an <a>, not a .nav-item div with data-page, so the existing
# page-switching handler ignores it and the browser just navigates. That
# keeps the single-page tab logic untouched.
#
set -euo pipefail

FILE="${1:-index.html}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${FILE}.bak-nav-${STAMP}"

[[ -f "$FILE" ]] || { echo "ERROR: $FILE not found. Run from the repo root." >&2; exit 1; }

if grep -q 'href="/certs"' "$FILE"; then
    echo "Certificates link already present — nothing to do."
    exit 0
fi

ANCHOR='<span class="nav-icon">⛓</span> VPN Fleet'
if ! grep -qF "$ANCHOR" "$FILE"; then
    echo "ERROR: could not find the VPN Fleet nav item to insert after." >&2
    exit 1
fi

cp "$FILE" "$BACKUP"
echo "→ backup : $BACKUP"

# ---- CSS: make the anchor sit flush with the div-based nav items ------
CSS_ANCHOR='  .nav-item.disabled:hover { background: none; color: var(--muted); }'
if ! grep -q 'a.nav-item' "$FILE"; then
    python3 - "$FILE" "$CSS_ANCHOR" <<'PY'
import sys
path, anchor = sys.argv[1], sys.argv[2]
css = anchor + """
  /* The Certificates entry is a real link to a separate page rather than
     a tab, so it needs the anchor defaults reset to match its siblings. */
  a.nav-item { text-decoration: none; color: var(--muted); }
  a.nav-item:hover { background: var(--panel-2); color: var(--text); }
  .nav-lock {
    margin-left: auto;
    font-size: 9px;
    font-family: var(--mono);
    color: var(--amber);
    border: 1px solid var(--amber);
    padding: 1px 5px;
    border-radius: 3px;
  }"""
s = open(path, encoding='utf-8').read()
s = s.replace(anchor, css, 1)
open(path, 'w', encoding='utf-8').write(s)
PY
    echo "→ added  : anchor + badge styles"
fi

# ---- the nav entry itself --------------------------------------------
python3 - "$FILE" <<'PY'
import sys
path = sys.argv[1]
s = open(path, encoding='utf-8').read()

old = '''  <div class="nav-item" data-page="fleet">
    <span class="nav-icon">\u26d3</span> VPN Fleet
  </div>'''

new = old + '''
  <a class="nav-item" href="/certs">
    <span class="nav-icon">\u26bf</span> Certificates <span class="nav-lock">sign in</span>
  </a>'''

if old not in s:
    sys.exit("ERROR: VPN Fleet nav block not found in expected form.")

s = s.replace(old, new, 1)
open(path, 'w', encoding='utf-8').write(s)
PY

echo "→ inserted: Certificates nav link"

grep -q 'href="/certs"' "$FILE" || { echo "ERROR: insert failed — reverting." >&2; cp "$BACKUP" "$FILE"; exit 1; }

echo "→ verified: link present"
echo
echo "Hard-refresh the dashboard (Ctrl+Shift+R) to see it."
echo "Revert with:  cp $BACKUP $FILE"
