// nudge.js — a gentle, in-app "log today?" reminder. No push, no server:
// this only ever shows while the app is actually open, checked against the
// last entry's date. Shown at most once per calendar day so re-opening the
// app repeatedly doesn't nag.

(function (global) {
  'use strict';

  const DAYS_THRESHOLD = 3;

  const MESSAGES = [
    "Hey champ, it's been a few days — how about today?",
    'Your scale misses you. Log today?',
    'Consistency beats perfection. One quick entry?',
    "A few days since your last check-in — no judgment, just a nudge.",
    'Progress loves company. Add today’s number?',
    "Quick one: how's today looking?",
    'Still tracking? Let’s log one.',
    'Small steps count. Got a minute for today’s entry?',
    'The trend line’s waiting on you.',
    'Been a bit — jump back in whenever you’re ready.',
    'One photo, one number, thirty seconds.',
    'Your future self will thank you for today’s entry.',
    'No streak to protect, but every entry still helps.',
    'Checking in — how’s it going?',
    'Ready when you are. Today’s a good day to log.',
  ];

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function daysSince(dateStr) {
    const then = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    return Math.floor((now - then) / 86400000);
  }

  // Returns a message string to show, or null if no nudge is due right now.
  // entries: ascending by date. settings: needs lastNudgeShownDate.
  function pickMessage(entries, settings) {
    if (!entries.length) return null; // the empty-state onboarding covers "no data yet"
    if (settings.lastNudgeShownDate === todayISO()) return null;
    const lastEntry = entries[entries.length - 1];
    if (daysSince(lastEntry.date) < DAYS_THRESHOLD) return null;
    return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  }

  async function markShownToday() {
    await FatterDB.setSetting('lastNudgeShownDate', todayISO());
  }

  global.FatterNudge = { pickMessage, markShownToday };
})(window);
