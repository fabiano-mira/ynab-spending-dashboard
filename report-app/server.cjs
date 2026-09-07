// Small YNAB spending report server (no dependencies, Node 18+).
// Reads YNAB_ACCESS_TOKEN from ../.env, serves an HTML UI and JSON report endpoints.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API = 'https://api.ynab.com/v1';

// --- load .env from repo root ---
const envPath = path.join(__dirname, '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const TOKEN = process.env.YNAB_ACCESS_TOKEN || env.YNAB_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing YNAB_ACCESS_TOKEN in .env');
  process.exit(1);
}

async function ynab(pathname) {
  const res = await fetch(API + pathname, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YNAB API ${res.status}: ${body}`);
  }
  return res.json();
}

// --- helpers ---
const toISO = (d) => d.toISOString().slice(0, 10);

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return toISO(d);
}

// Payees that are not real spending
const BALANCE_PAYEES = /^(starting balance|reconciliation balance adjustment|manual balance adjustment|balance adjustment)$/i;
// Credit card / loan payment payees (double-count spending already on the card)
const PAYMENT_PAYEES = /\b(payment|pmt|autopay|e-?pay)\b|^(elan|upstart network|upgrade)$/i;

// Spending buckets, matched in order (first match wins).
const LARGE_ONE_OFF_MILLIUNITS = 1000 * 1000; // >= $1,000 in a single transaction
const BUCKET_RULES = [
  ['Housing & Utilities', /coserv|solar servicing|vivint|optimum|rent|mortgage|electric|water util/i],
  ['Subscriptions & Software', /warp\.dev|microsoft|^apple$|anthropic|apify|mailopoly|disney|netflix|prime video|truecaller|proton|cloudflare|ngrok|sophos|beenverified|dark web informer|hinge|spring health|track nine|infinite paths|spotify|subscription/i],
  ['Food & Groceries', /doordash|taco bell|mcdonald|brown bag|rick's drive|kroger|walmart|7-eleven|grocer|uber eats|starbucks|chipotle|restaurant/i],
  ['Gas & Auto', /racetrac|exxon|quiktrip|towing|allstate|shell oil|chevron|autozone|car wash/i],
  ['Health & Personal', /cvs|pharmacy|supercuts|clinic|dental|doctor/i],
  ['People & Services', /zelle|venmo|cash app|law offices|adriana|jaime barron|dog sitting/i],
  ['Investments & Crypto', /moonpay|fidelity|hsa contribution|reinvestment|coinbase|robinhood|distribution/i],
];

function bucketFor(payeeName, spentMilli) {
  if (spentMilli >= LARGE_ONE_OFF_MILLIUNITS) return 'Large One-Offs';
  for (const [bucket, re] of BUCKET_RULES) {
    if (re.test(payeeName)) return bucket;
  }
  return 'Other';
}

function buildReport(transactions, currency, periodDays, offBudgetAccountIds) {
  const daily = {};
  const weekly = {};
  const categories = {};
  const payees = {};
  const buckets = {};
  const bucketPayees = {};
  const txnRows = [];
  let totalSpent = 0;
  let totalInflow = 0;

  const addSpend = (txn, amount, categoryName) => {
    // amount is in milliunits; negative = outflow
    if (amount < 0) {
      const spent = -amount;
      totalSpent += spent;
      daily[txn.date] = (daily[txn.date] || 0) + spent;
      const wk = mondayOf(txn.date);
      weekly[wk] = (weekly[wk] || 0) + spent;
      const cat = categoryName || 'Uncategorized';
      categories[cat] = (categories[cat] || 0) + spent;
      const payee = txn.payee_name || 'Unknown';
      payees[payee] = (payees[payee] || 0) + spent;
      const bucket = bucketFor(payee, spent);
      buckets[bucket] = (buckets[bucket] || 0) + spent;
      if (!bucketPayees[bucket]) bucketPayees[bucket] = {};
      bucketPayees[bucket][payee] = (bucketPayees[bucket][payee] || 0) + spent;
      txnRows.push({
        date: txn.date,
        payee,
        bucket,
        account: txn.account_name || '',
        category: categoryName || 'Uncategorized',
        amount: Math.round(spent) / 1000,
      });
    } else {
      totalInflow += amount;
    }
  };

  for (const t of transactions) {
    if (t.deleted) continue;
    if (t.transfer_account_id) continue; // skip transfers between accounts
    if (offBudgetAccountIds.has(t.account_id)) continue; // skip tracking accounts (loans, IRA, etc.)
    const payeeName = t.payee_name || '';
    if (BALANCE_PAYEES.test(payeeName.trim())) continue; // skip starting balances / adjustments
    // skip CC/loan payments (but Zelle/Venmo payments to people are real spending)
    if (t.amount < 0 && PAYMENT_PAYEES.test(payeeName) && !/zelle|venmo|cash app/i.test(payeeName)) continue;
    if (t.subtransactions && t.subtransactions.length > 0) {
      for (const st of t.subtransactions) {
        if (st.deleted || st.transfer_account_id) continue;
        addSpend(t, st.amount, st.category_name || t.category_name);
      }
    } else {
      addSpend(t, t.amount, t.category_name);
    }
  }

  const milli = (v) => Math.round(v) / 1000;
  const sortDesc = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ key: k, amount: milli(v) }));
  const sortByDate = (obj) =>
    Object.entries(obj)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([k, v]) => ({ key: k, amount: milli(v) }));

  const dailyRows = sortByDate(daily);
  const weeklyRows = sortByDate(weekly);
  const numDays = periodDays || Object.keys(daily).length || 1;

  // Bucket summary + per-bucket payee breakdown, sorted by amount desc
  const bucketRows = Object.entries(buckets)
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => ({
      key: name,
      amount: milli(v),
      pct: totalSpent > 0 ? Math.round((v / totalSpent) * 100) : 0,
      items: Object.entries(bucketPayees[name])
        .sort((a, b) => b[1] - a[1])
        .map(([p, pv]) => ({ key: p, amount: milli(pv) })),
    }));

  // Everyday spend = everything except large one-offs
  const largeTotal = buckets['Large One-Offs'] || 0;
  const everydaySpent = totalSpent - largeTotal;

  return {
    currency,
    totalSpent: milli(totalSpent),
    totalInflow: milli(totalInflow),
    avgPerDay: milli(totalSpent / numDays),
    everydaySpent: milli(everydaySpent),
    everydayAvgPerDay: milli(everydaySpent / numDays),
    buckets: bucketRows,
    daily: dailyRows,
    weekly: weeklyRows,
    categories: sortDesc(categories),
    payees: sortDesc(payees).slice(0, 25),
    transactions: txnRows.sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

// --- routes ---
async function handleApi(url, res) {
  if (url.pathname === '/api/plans') {
    const data = await ynab('/plans');
    const plans = data.data.plans.map((p) => ({
      id: p.id,
      name: p.name,
      currency: p.currency_format ? p.currency_format.iso_code : '',
    }));
    return send(res, 200, plans);
  }

  if (url.pathname === '/api/report') {
    const planId = url.searchParams.get('plan_id');
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    if (!planId) return send(res, 400, { error: 'plan_id required' });
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceDate = toISO(since);

    const [txns, plan, accounts] = await Promise.all([
      ynab(`/plans/${planId}/transactions?since_date=${sinceDate}`),
      ynab(`/plans/${planId}`),
      ynab(`/plans/${planId}/accounts`),
    ]);
    const currency = plan.data.plan.currency_format
      ? plan.data.plan.currency_format.iso_code
      : '';
    const offBudget = new Set(
      accounts.data.accounts.filter((a) => !a.on_budget).map((a) => a.id)
    );
    const report = buildReport(txns.data.transactions, currency, days, offBudget);
    report.sinceDate = sinceDate;
    return send(res, 200, report);
  }

  if (url.pathname === '/api/raw' || url.pathname === '/api/export.csv') {
    const planId = url.searchParams.get('plan_id');
    if (!planId) return send(res, 400, { error: 'plan_id required' });
    const data = await ynab(`/plans/${planId}/transactions`); // no since_date: everything
    const rows = [];
    for (const t of data.data.transactions) {
      if (t.deleted) continue;
      const base = {
        date: t.date,
        payee: t.payee_name || '',
        category: t.category_name || '',
        account: t.account_name || '',
        memo: t.memo || '',
        amount: Math.round(t.amount) / 1000,
        type: t.transfer_account_id ? 'Transfer' : t.amount < 0 ? 'Outflow' : 'Inflow',
        cleared: t.cleared,
        approved: t.approved ? 'yes' : 'no',
      };
      if (t.subtransactions && t.subtransactions.length > 0) {
        for (const st of t.subtransactions) {
          if (st.deleted) continue;
          rows.push({
            ...base,
            category: st.category_name || base.category,
            memo: st.memo || base.memo,
            amount: Math.round(st.amount) / 1000,
            type: st.transfer_account_id ? 'Transfer' : st.amount < 0 ? 'Outflow' : 'Inflow',
          });
        }
      } else {
        rows.push(base);
      }
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));

    if (url.pathname === '/api/raw') return send(res, 200, { count: rows.length, rows });

    // CSV for Excel (UTF-8 BOM so Excel renders accents/emoji correctly)
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['Date', 'Payee', 'Category', 'Account', 'Memo', 'Amount', 'Type', 'Cleared', 'Approved'];
    const csv = '\ufeff' + [header.join(',')]
      .concat(rows.map((r) => [r.date, r.payee, r.category, r.account, r.memo, r.amount, r.type, r.cleared, r.approved].map(esc).join(',')))
      .join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ynab-all-transactions.csv"',
    });
    return res.end(csv);
  }

  send(res, 404, { error: 'not found' });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(url, res);
    } else {
      const pages = {
        '/charts': 'charts.html', '/charts.html': 'charts.html',
        '/advisor': 'advisor.html', '/advisor.html': 'advisor.html',
        '/raw': 'raw.html', '/raw.html': 'raw.html',
      };
      const page = pages[url.pathname] || 'index.html';
      const html = fs.readFileSync(path.join(__dirname, page));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
  } catch (err) {
    console.error(err);
    send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`YNAB report app running at http://localhost:${PORT}`);
});
