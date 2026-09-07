// Schedules the daily digest email while the container/process stays running.
const { sendDailyDigest } = require('./mailer.cjs');

function msUntilNextRun(hour) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleNext() {
  const hour = parseInt(process.env.MAIL_HOUR || '7', 10);
  const delay = msUntilNextRun(hour);
  console.log(`[scheduler] next daily digest in ${Math.round(delay / 60000)} min (at ${hour}:00 local time)`);
  setTimeout(async () => {
    try {
      await sendDailyDigest();
      console.log('[scheduler] digest sent at', new Date().toISOString());
    } catch (e) {
      console.error('[scheduler] failed to send digest:', e.message);
    }
    scheduleNext();
  }, delay);
}

if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_TO) {
  scheduleNext();
} else {
  console.log('[scheduler] SMTP_USER/SMTP_PASS/MAIL_TO not set — daily digest email disabled');
}
