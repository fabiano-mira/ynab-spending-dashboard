// Builds a daily YNAB digest and emails it via SMTP (no external deps).
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// ---------- env ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}
const FILE_ENV = loadEnv();
const cfg = (k) => process.env[k] || FILE_ENV[k];

const TOKEN = cfg('YNAB_ACCESS_TOKEN');
const API = 'https://api.ynab.com/v1';

async function ynab(pathname) {
  const res = await fetch(API + pathname, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`YNAB API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------- bucket rules (mirrors server.cjs) ----------
const BUCKET_RULES = [
  ['Housing & Utilities', /coserv|solar servicing|vivint|optimum|rent|mortgage|electric|water util/i],
  ['Subscriptions & Software', /warp\.dev|microsoft|^apple$|anthropic|apify|mailopoly|disney|netflix|prime video|truecaller|proton|cloudflare|ngrok|sophos|beenverified|dark web informer|hinge|spring health|track nine|infinite paths|spotify|subscription/i],
  ['Food & Groceries', /doordash|taco bell|mcdonald|brown bag|rick's drive|kroger|walmart|7-eleven|grocer|uber eats|starbucks|chipotle|restaurant/i],
  ['Gas & Auto', /racetrac|exxon|quiktrip|towing|allstate|shell oil|chevron|autozone|car wash/i],
  ['Health & Personal', /cvs|pharmacy|supercuts|clinic|dental|doctor/i],
  ['People & Services', /zelle|venmo|cash app|law offices|adriana|jaime barron|dog sitting/i],
  ['Investments & Crypto', /moonpay|fidelity|hsa contribution|reinvestment|coinbase|robinhood|distribution/i],
];
function bucketFor(payee, spentMilli) {
  if (spentMilli >= 1000 * 1000) return 'Large One-Offs';
  for (const [b, re] of BUCKET_RULES) if (re.test(payee)) return b;
  return 'Other';
}
const BALANCE_RE = /^(starting balance|reconciliation balance adjustment|manual balance adjustment|balance adjustment)$/i;
const PAYMENT_RE = /\b(payment|pmt|autopay|e-?pay)\b|^(elan|upstart network|upgrade)$/i;

const fmtMoney = (n, cur) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur ? ' ' + cur : '');
const toISO = (d) => d.toISOString().slice(0, 10);

// ---------- data gathering ----------
async function buildDigest() {
  const plans = (await ynab('/plans')).data.plans;
  const plan = plans[0];
  const currency = plan.currency_format ? plan.currency_format.iso_code : '';

  const since45 = toISO(new Date(Date.now() - 45 * 86400000));
  const [txnsResp, monthResp] = await Promise.all([
    ynab(`/plans/${plan.id}/transactions?since_date=${since45}`),
    ynab(`/plans/${plan.id}/months/current`),
  ]);

  const today = toISO(new Date());
  const yesterday = toISO(new Date(Date.now() - 86400000));
  const since7 = toISO(new Date(Date.now() - 7 * 86400000));

  const rows = [];
  for (const t of txnsResp.data.transactions) {
    if (t.deleted || t.transfer_account_id) continue;
    const payee = t.payee_name || 'Unknown';
    if (BALANCE_RE.test(payee.trim())) continue;
    if (t.amount < 0 && PAYMENT_RE.test(payee) && !/zelle|venmo|cash app/i.test(payee)) continue;
    const items = t.subtransactions && t.subtransactions.length
      ? t.subtransactions.filter((s) => !s.deleted && !s.transfer_account_id).map((s) => ({ amount: s.amount, category: s.category_name || t.category_name }))
      : [{ amount: t.amount, category: t.category_name }];
    for (const it of items) {
      if (it.amount >= 0) continue;
      const spent = -it.amount / 1000;
      rows.push({ date: t.date, payee, amount: spent, bucket: bucketFor(payee, -it.amount), category: it.category || 'Uncategorized' });
    }
  }

  const yesterdayRows = rows.filter((r) => r.date === yesterday);
  const weekRows = rows.filter((r) => r.date >= since7);
  const yesterdayTotal = yesterdayRows.reduce((s, r) => s + r.amount, 0);
  const weekTotal = weekRows.reduce((s, r) => s + r.amount, 0);

  const byBucketWeek = {};
  for (const r of weekRows) byBucketWeek[r.bucket] = (byBucketWeek[r.bucket] || 0) + r.amount;
  const bucketRows = Object.entries(byBucketWeek).sort((a, b) => b[1] - a[1]);

  // subscriptions due in next 3 days
  const subsPayees = {};
  for (const r of rows) {
    if (r.bucket === 'Subscriptions & Software') (subsPayees[r.payee] = subsPayees[r.payee] || []).push(r);
  }
  const dueSoon = [];
  const now = new Date();
  for (const [payee, list] of Object.entries(subsPayees)) {
    list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const last = list[0];
    const day = Math.min(parseInt(last.date.slice(8, 10), 10), 28);
    const next = new Date(now.getFullYear(), now.getMonth(), day);
    if (next < now) next.setMonth(next.getMonth() + 1);
    const daysAway = Math.round((next - now) / 86400000);
    if (daysAway <= 3) dueSoon.push({ payee, amount: last.amount, date: toISO(next), daysAway });
  }
  dueSoon.sort((a, b) => a.daysAway - b.daysAway);

  // budget vs actual (current month)
  const SKIP_CATS = new Set(['Uncategorized', 'Inflow: Ready to Assign']);
  const overBudget = [];
  for (const c of monthResp.data.month.categories) {
    if (c.hidden || c.deleted || SKIP_CATS.has(c.name)) continue;
    if (c.budgeted === 0 && c.activity === 0) continue;
    const spent = -c.activity / 1000;
    const budgeted = c.budgeted / 1000;
    if (budgeted > 0 && spent > budgeted) {
      overBudget.push({ name: c.name, spent, budgeted, over: spent - budgeted });
    }
  }

  const topPayees = Object.entries(
    weekRows.reduce((acc, r) => ((acc[r.payee] = (acc[r.payee] || 0) + r.amount), acc), {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return { currency, today, yesterday, yesterdayTotal, weekTotal, bucketRows, dueSoon, overBudget, topPayees };
}

function renderText(d) {
  const m = (n) => fmtMoney(n, d.currency);
  const lines = [
    `YNAB Daily Digest — ${d.today}`,
    ``,
    `Yesterday (${d.yesterday}): ${m(d.yesterdayTotal)}`,
    `Last 7 days: ${m(d.weekTotal)}`,
    ``,
    `Top payees (7d):`,
    ...d.topPayees.map(([p, v]) => `  ${p}: ${m(v)}`),
    ``,
    `Spend by bucket (7d):`,
    ...d.bucketRows.map(([b, v]) => `  ${b}: ${m(v)}`),
  ];
  if (d.overBudget.length) {
    lines.push('', 'Over budget this month:', ...d.overBudget.map((c) => `  ${c.name}: ${m(c.spent)} of ${m(c.budgeted)} (over by ${m(c.over)})`));
  }
  if (d.dueSoon.length) {
    lines.push('', 'Subscriptions due in next 3 days:', ...d.dueSoon.map((s) => `  ${s.payee}: ${m(s.amount)} on ${s.date}`));
  }
  return lines.join('\n');
}

function renderHtml(d) {
  const m = (n) => fmtMoney(n, d.currency);
  const row = (l, r) => `<tr><td style="padding:4px 10px;color:#444">${l}</td><td style="padding:4px 10px;text-align:right;font-weight:600">${r}</td></tr>`;
  const section = (title, rowsHtml) => rowsHtml ? `<h3 style="margin:18px 0 6px;font-size:14px;color:#333">${title}</h3><table style="width:100%;border-collapse:collapse;font-size:13px">${rowsHtml}</table>` : '';
  return `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1c2130">
    <h2 style="margin:0 0 4px">💸 YNAB Daily Digest</h2>
    <p style="color:#888;margin:0 0 16px">${d.today}</p>
    <div style="display:flex;gap:10px;margin-bottom:10px">
      <div style="flex:1;background:#f6f8ff;border-radius:10px;padding:12px"><div style="font-size:11px;color:#888">YESTERDAY</div><div style="font-size:18px;font-weight:700">${m(d.yesterdayTotal)}</div></div>
      <div style="flex:1;background:#f6f8ff;border-radius:10px;padding:12px"><div style="font-size:11px;color:#888">LAST 7 DAYS</div><div style="font-size:18px;font-weight:700">${m(d.weekTotal)}</div></div>
    </div>
    ${section('Top payees (7d)', d.topPayees.map(([p, v]) => row(p, m(v))).join(''))}
    ${section('Spend by bucket (7d)', d.bucketRows.map(([b, v]) => row(b, m(v))).join(''))}
    ${d.overBudget.length ? section('⚠️ Over budget this month', d.overBudget.map((c) => row(c.name, `${m(c.spent)} / ${m(c.budgeted)}`)).join('')) : ''}
    ${d.dueSoon.length ? section('📅 Subscriptions due soon', d.dueSoon.map((s) => row(`${s.payee} (${s.date})`, m(s.amount))).join('')) : ''}
    <p style="color:#aaa;font-size:11px;margin-top:24px">Sent automatically by your YNAB report app.</p>
  </div>`;
}

// ---------- minimal SMTP client (STARTTLS + AUTH LOGIN) ----------
function makeReader(socket) {
  let buffer = '';
  let pending = null;
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    flush();
  });
  function flush() {
    if (!pending) return;
    const lines = buffer.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && /^\d{3} /.test(last)) {
      const code = parseInt(last.slice(0, 3), 10);
      const text = buffer;
      buffer = '';
      const resolve = pending;
      pending = null;
      resolve({ code, text });
    }
  }
  return () => new Promise((resolve) => { pending = resolve; flush(); });
}

function sendCmd(socket, cmd) {
  socket.write(cmd + '\r\n');
}

function dotStuff(message) {
  return message.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

async function sendMail({ subject, text, html }) {
  const host = cfg('SMTP_HOST');
  const port = parseInt(cfg('SMTP_PORT') || '587', 10);
  const user = cfg('SMTP_USER');
  const pass = cfg('SMTP_PASS');
  const to = cfg('MAIL_TO');
  if (!host || !user || !pass || !to) throw new Error('Missing SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_TO');

  let socket = net.connect(port, host);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let read = makeReader(socket);

  const expect = async (label) => {
    const r = await read();
    if (r.code >= 400) throw new Error(`SMTP ${label} failed: ${r.text.trim()}`);
    return r;
  };

  await expect('greeting');
  sendCmd(socket, `EHLO localhost`); await expect('EHLO');
  sendCmd(socket, 'STARTTLS'); await expect('STARTTLS');

  const tlsSocket = tls.connect({ socket, servername: host });
  await new Promise((resolve, reject) => { tlsSocket.once('secureConnect', resolve); tlsSocket.once('error', reject); });
  socket = tlsSocket;
  read = makeReader(socket);

  sendCmd(socket, `EHLO localhost`); await expect('EHLO2');
  sendCmd(socket, 'AUTH LOGIN'); await expect('AUTH LOGIN');
  sendCmd(socket, Buffer.from(user).toString('base64')); await expect('username');
  sendCmd(socket, Buffer.from(pass).toString('base64')); await expect('password');

  sendCmd(socket, `MAIL FROM:<${user}>`); await expect('MAIL FROM');
  sendCmd(socket, `RCPT TO:<${to}>`); await expect('RCPT TO');
  sendCmd(socket, 'DATA'); await expect('DATA');

  const boundary = 'ynab-digest-' + Date.now();
  const headers = [
    `From: YNAB Report <${user}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const body = [
    `--${boundary}`, `Content-Type: text/plain; charset=utf-8`, ``, text,
    `--${boundary}`, `Content-Type: text/html; charset=utf-8`, ``, html,
    `--${boundary}--`, ``,
  ].join('\r\n');
  const message = dotStuff(headers + '\r\n\r\n' + body);
  socket.write(message + '\r\n.\r\n');
  await expect('message body');

  sendCmd(socket, 'QUIT');
  socket.end();
}

async function sendDailyDigest() {
  const digest = await buildDigest();
  await sendMail({
    subject: `YNAB Daily Digest — ${digest.today} (${fmtMoney(digest.yesterdayTotal, digest.currency)} yesterday)`,
    text: renderText(digest),
    html: renderHtml(digest),
  });
  return digest;
}

module.exports = { sendDailyDigest, buildDigest };

if (require.main === module) {
  sendDailyDigest()
    .then((d) => { console.log('Digest sent. Yesterday total:', d.yesterdayTotal, d.currency); })
    .catch((e) => { console.error('Failed to send digest:', e.message); process.exit(1); });
}
