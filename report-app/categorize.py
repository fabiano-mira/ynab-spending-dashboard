#!/usr/bin/env python3
"""Auto-categorize uncategorized YNAB transactions using payee rules.

Reads YNAB_ACCESS_TOKEN from env. Only touches transactions that are
currently uncategorized, skips transfers, splits, and inflows.
Run with --dry-run to preview without writing.
"""
import json
import os
import re
import sys
import urllib.request
import datetime

TOKEN = os.environ.get('YNAB_ACCESS_TOKEN')
if not TOKEN:
    sys.exit('Missing YNAB_ACCESS_TOKEN in environment')
API = 'https://api.ynab.com/v1'
DRY_RUN = '--dry-run' in sys.argv
DAYS = 90


def call(path, method='GET', body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)


# --- payee -> category-name rules (first match wins) ---
RULES = [
    (r"walmart|kroger|grocer", '🛒 Groceries'),
    (r"doordash|uber eats|grubhub|taco bell|mcdonald|brown bag|rick's drive|7-eleven|starbucks|chipotle|restaurant|dnav vend|quiktrip.*food", '🍽️ Dining out'),
    (r"racetrac|exxon|quiktrip|chevron|shell oil|towing|allstate|autozone|car wash|parking|uber(?! eats)|lyft", '🚘 Transportation'),
    (r"coserv|solar servicing|vivint|electric|water util|gas util", '⚡️ Utilities'),
    (r"optimum|t-mobile|verizon|at&t|comcast|spectrum", '📱 Phone & Internet'),
    (r"cvs|pharmacy|spring health|clinic|dental|doctor|medical", '🩺 Medical expenses'),
    (r"upstart|upgrade|sofi|loan", 'Loans'),
    (r"netflix|disney|prime video|hinge|hbo|spotify|hulu|cinema|movie", '🍿 Entertainment'),
    (r"warp\.dev|microsoft|^apple$|anthropic|apify|mailopoly|truecaller|proton|cloudflare|ngrok|sophos|beenverified|dark web|track nine|infinite paths|subscription", 'SUBSCRIPTIONS'),
    (r"zelle|venmo|law offices|adriana|jaime barron|dog sitting|supercuts|amazon|ups store|checkcard|purchase \d|gc4?ss|gc ss|moonpay|felicio", '❗️ Stuff I forgot to plan for'),
]

SKIP_PAYEES = re.compile(
    r'starting balance|balance adjustment|payment made by account|ach pmt|apple card payment|^elan$'
    r'|early distribution|normal distribution|reinvestment|fidelity|hsa contribution',
    re.I,
)

plan_id = call('/plans')['data']['plans'][0]['id']

# --- categories ---
cat_data = call(f'/plans/{plan_id}/categories')['data']['category_groups']
cats = {}
groups = {}
for g in cat_data:
    groups[g['name']] = g['id']
    for c in g['categories']:
        if not c.get('hidden') and not c.get('deleted'):
            cats[c['name']] = c['id']

# Create (or reuse) a Subscriptions category under "Bills" if possible
subs_name = '💻 Subscriptions & Software'
if subs_name not in cats:
    created = False
    try:
        r = call(f'/plans/{plan_id}/category_groups/{groups["Bills"]}',
                 'POST', {'category': {'name': subs_name}})
        cid = r['data']['category']['id']
        cats[subs_name] = cid
        created = True
        print(f'Created category: {subs_name}')
    except Exception:
        pass
    if not created:
        try:
            r = call(f'/plans/{plan_id}/categories', 'POST',
                     {'category': {'name': subs_name, 'category_group_id': groups['Bills']}})
            cats[subs_name] = r['data']['category']['id']
            created = True
            print(f'Created category: {subs_name}')
        except Exception as e:
            print(f'Could not create subscriptions category ({e}); using 🍿 Entertainment')

SUBS_TARGET = cats.get(subs_name, cats.get('🍿 Entertainment'))


def category_for(payee):
    for pattern, name in RULES:
        if re.search(pattern, payee, re.I):
            return (SUBS_TARGET, subs_name) if name == 'SUBSCRIPTIONS' else (cats.get(name), name)
    return (None, None)


# --- transactions ---
since = (datetime.date.today() - datetime.timedelta(days=DAYS)).isoformat()
txns = call(f'/plans/{plan_id}/transactions?since_date={since}')['data']['transactions']

updates, summary, skipped = [], {}, 0
for t in txns:
    if t['deleted'] or t.get('transfer_account_id'):
        continue
    if t.get('subtransactions') and len(t['subtransactions']) > 0:
        continue  # don't touch splits
    if t.get('category_name') not in (None, 'Uncategorized'):
        continue  # already categorized by user
    if t['amount'] >= 0:
        continue  # leave inflows alone
    payee = t.get('payee_name') or ''
    if SKIP_PAYEES.search(payee):
        skipped += 1
        continue
    cid, cname = category_for(payee)
    if not cid:
        skipped += 1
        continue
    updates.append({'id': t['id'], 'category_id': cid})
    summary.setdefault(cname, []).append((payee[:40], -t['amount'] / 1000))

print(f'\nPlan: {plan_id}')
print(f'Transactions to categorize: {len(updates)} (skipped: {skipped})\n')
for cname, items in sorted(summary.items(), key=lambda x: -sum(a for _, a in x[1])):
    total = sum(a for _, a in items)
    print(f'{cname}  —  {len(items)} txns, {total:,.2f}')
    seen = {}
    for p, a in items:
        seen[p] = seen.get(p, 0) + a
    for p, a in sorted(seen.items(), key=lambda x: -x[1])[:6]:
        print(f'    {p:<42} {a:>10,.2f}')

if DRY_RUN:
    print('\nDRY RUN — nothing written. Re-run without --dry-run to apply.')
elif updates:
    resp = call(f'/plans/{plan_id}/transactions', 'PATCH', {'transactions': updates})
    done = resp['data'].get('transactions', [])
    print(f'\n✅ Updated {len(done)} transactions in YNAB.')
else:
    print('\nNothing to update.')
