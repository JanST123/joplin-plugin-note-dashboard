// Run with: npm test
const assert = require('assert');
const d = require("../.test-build/dashboard.js");

const note = (o) => ({
  id: o.id,
  title: o.title || '',
  is_todo: o.is_todo ?? 0,
  todo_completed: o.todo_completed ?? 0,
  todo_due: o.todo_due ?? 0,
  ...(o.deleted_time !== undefined ? { deleted_time: o.deleted_time } : {}),
  ...(o.is_conflict !== undefined ? { is_conflict: o.is_conflict } : {}),
});

// Local-time constructor so the tests describe wall-clock intent, matching the
// production code (which buckets on local calendar days).
const at = (y, m, day, h, min = 0) => new Date(y, m - 1, day, h, min, 0, 0).getTime();

// August 2026: 24th is a Monday, 28th a Friday, 29th Saturday, 30th Sunday.
const MON = 24, TUE = 25, FRI = 28, SAT = 29, SUN = 30;
assert.strictEqual(new Date(at(2026, 8, MON, 12)).getDay(), 1, 'fixture: 24 Aug 2026 is a Monday');
assert.strictEqual(new Date(at(2026, 8, FRI, 12)).getDay(), 5, 'fixture: 28 Aug 2026 is a Friday');

// ===========================================================================
// Calendar helpers
// ===========================================================================

// addDays must move calendar days, not add 86400000ms — otherwise a DST
// transition shifts the hour and the cutoffs drift.
for (const [y, m, day] of [[2026, 3, 29], [2026, 10, 25], [2026, 8, 24]]) {
  const start = at(y, m, day, 12);
  const next = d.addDays(start, 1);
  assert.strictEqual(new Date(next).getHours(), 12, `addDays kept the hour across ${y}-${m}-${day}`);
  assert.strictEqual(new Date(next).getDate(), new Date(at(y, m, day + 1, 12)).getDate());
}

assert.strictEqual(d.atHour(at(2026, 8, MON, 23, 47), 16), at(2026, 8, MON, 16));
assert.strictEqual(new Date(d.atHour(at(2026, 8, MON, 5), 0)).getHours(), 0);

assert.strictEqual(d.isWeekend(at(2026, 8, SAT, 12)), true);
assert.strictEqual(d.isWeekend(at(2026, 8, SUN, 12)), true);
assert.strictEqual(d.isWeekend(at(2026, 8, MON, 12)), false);
assert.strictEqual(d.isWeekend(at(2026, 8, FRI, 12)), false);

assert.ok(d.isSameDay(at(2026, 8, MON, 0, 1), at(2026, 8, MON, 23, 59)));
assert.ok(!d.isSameDay(at(2026, 8, MON, 23, 59), at(2026, 8, TUE, 0, 1)));

// nextWorkday skips the weekend.
const nwDay = (from) => new Date(d.nextWorkday(from)).getDate();
assert.strictEqual(nwDay(at(2026, 8, MON, 10)), TUE, 'Mon -> Tue');
assert.strictEqual(nwDay(at(2026, 8, FRI, 10)), MON + 7, 'Fri -> Mon');
assert.strictEqual(nwDay(at(2026, 8, SAT, 10)), MON + 7, 'Sat -> Mon');
assert.strictEqual(nwDay(at(2026, 8, SUN, 10)), MON + 7, 'Sun -> Mon');

// ===========================================================================
// Bucketing
// ===========================================================================

const b = (nowTs, dueTs) => d.bucketOf(dueTs, nowTs);

// --- The case the original 8h/36h spec got wrong ---
// At 07:00, a to-do due today at 18:00 belongs to Today, not tomorrow.
assert.strictEqual(b(at(2026, 8, MON, 7), at(2026, 8, MON, 18)), 'today');
assert.strictEqual(b(at(2026, 8, MON, 7), at(2026, 8, MON, 15)), 'today');

// --- Overdue is always Today, even past the cutoff ---
// (A naive `due <= todayCutoff` test would put this in nextWorkday.)
assert.strictEqual(b(at(2026, 8, MON, 20), at(2026, 8, MON, 19)), 'today', 'overdue after cutoff');
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 7, 1, 9)), 'today', 'long overdue');
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 8, MON, 9, 59)), 'today', 'just overdue');

// --- Cutoff boundary (18:00) ---
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 8, MON, 18)), 'today', '18:00 exactly is today');
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 8, MON, 18, 1)), 'nextWorkday', 'after cutoff rolls over');

// --- Next-workday band ---
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 8, TUE, 8)), 'nextWorkday');
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 8, TUE, 18)), 'nextWorkday', 'Tue 18:00 exactly');
assert.strictEqual(b(at(2026, 8, MON, 10), at(2026, 8, TUE, 18, 1)), 'later');

// On a Friday the band runs to Monday 18:00 and absorbs the weekend, so nothing
// due on Sat/Sun is stranded in `later`.
assert.strictEqual(b(at(2026, 8, FRI, 10), at(2026, 8, SAT, 12)), 'nextWorkday', 'Sat is absorbed');
assert.strictEqual(b(at(2026, 8, FRI, 10), at(2026, 8, SUN, 12)), 'nextWorkday', 'Sun is absorbed');
assert.strictEqual(b(at(2026, 8, FRI, 10), at(2026, 8, MON + 7, 8)), 'nextWorkday', 'Mon morning');
assert.strictEqual(b(at(2026, 8, FRI, 10), at(2026, 8, MON + 7, 18, 1)), 'later');

// --- Undated to-dos land in Later ---
assert.strictEqual(b(at(2026, 8, MON, 10), 0), 'later');

// ===========================================================================
// THE round-trip invariant
//
// Dropping a to-do on a section must place it in that same section. This is the
// property the original 8h/36h + wall-clock-drop design violated: at 07:00 a
// to-do dropped on "Today" got 16:00, which was 9h away, so it rendered under
// the next section instead.
//
// Checked exhaustively over 400 consecutive days x every hour x every bucket,
// which covers both DST transitions in the local zone.
// ===========================================================================
let roundTrips = 0;
for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
  for (let hour = 0; hour < 24; hour++) {
    const now = d.atHour(d.addDays(at(2026, 1, 1, 12), dayOffset), hour);
    for (const bucket of d.BUCKETS) {
      const due = d.dropDueDate(bucket, now);
      const landed = d.bucketOf(due, now);
      assert.strictEqual(
        landed, bucket,
        `drop on "${bucket}" at ${new Date(now).toString()} landed in "${landed}" (due ${due ? new Date(due).toString() : 'cleared'})`,
      );
      roundTrips++;
    }
  }
}
assert.strictEqual(roundTrips, 400 * 24 * 3);

// Drop targets set the agreed times.
assert.strictEqual(d.dropDueDate('today', at(2026, 8, MON, 10)), at(2026, 8, MON, 16));
assert.strictEqual(d.dropDueDate('nextWorkday', at(2026, 8, MON, 10)), at(2026, 8, TUE, 8));
assert.strictEqual(d.dropDueDate('nextWorkday', at(2026, 8, FRI, 10)), at(2026, 8, MON + 7, 8), 'Fri -> Mon 08:00');
assert.strictEqual(d.dropDueDate('later', at(2026, 8, MON, 10)), 0, 'later clears the date');

// Dropping on Today after 16:00 yields an already-overdue to-do — accepted
// behaviour, and it stays in Today rather than jumping elsewhere.
const lateDrop = d.dropDueDate('today', at(2026, 8, MON, 17));
assert.ok(lateDrop < at(2026, 8, MON, 17), 'is in the past');
assert.strictEqual(d.bucketOf(lateDrop, at(2026, 8, MON, 17)), 'today');

// Bucket validation guards the webview -> plugin boundary.
assert.ok(d.isBucket('today') && d.isBucket('nextWorkday') && d.isBucket('later'));
for (const bad of ['Today', 'tomorrow', '', null, undefined, 0, {}, []]) {
  assert.strictEqual(d.isBucket(bad), false, `isBucket(${JSON.stringify(bad)})`);
}

// ===========================================================================
// bucketTodos: membership, exclusions, ordering
// ===========================================================================

const NOW = at(2026, 8, MON, 10);
const notes = [
  note({ id: 'overdue',   title: 'Overdue',        is_todo: 1, todo_due: at(2026, 8, 20, 9) }),
  note({ id: 'today-15',  title: 'Today 15:00',    is_todo: 1, todo_due: at(2026, 8, MON, 15) }),
  note({ id: 'today-18',  title: 'Today 18:00',    is_todo: 1, todo_due: at(2026, 8, MON, 18) }),
  note({ id: 'tonight',   title: 'Today 21:00',    is_todo: 1, todo_due: at(2026, 8, MON, 21) }),
  note({ id: 'tue-am',    title: 'Tue 08:00',      is_todo: 1, todo_due: at(2026, 8, TUE, 8) }),
  note({ id: 'wed',       title: 'Wed 09:00',      is_todo: 1, todo_due: at(2026, 8, 26, 9) }),
  note({ id: 'undated',   title: 'No date',        is_todo: 1, todo_due: 0 }),
  note({ id: 'done',      title: 'Done today',     is_todo: 1, todo_due: at(2026, 8, MON, 11), todo_completed: NOW }),
  note({ id: 'plain',     title: 'Plain note' }),
  note({ id: 'pinned',    title: '📌 Pinned note' }),
];

const buckets = d.bucketTodos(notes, NOW);
assert.deepStrictEqual(buckets.today.map(n => n.id), ['overdue', 'today-15', 'today-18'], 'today');
assert.deepStrictEqual(buckets.nextWorkday.map(n => n.id), ['tonight', 'tue-am'], 'nextWorkday');
assert.deepStrictEqual(buckets.later.map(n => n.id), ['wed', 'undated'], 'later: dated first, undated last');

// Completed to-dos and plain notes are in no bucket at all.
const allBucketed = [...buckets.today, ...buckets.nextWorkday, ...buckets.later].map(n => n.id);
for (const id of ['done', 'plain', 'pinned']) {
  assert.ok(!allBucketed.includes(id), `${id} must not be bucketed`);
}
assert.strictEqual(d.isOpenTodo(note({ id: 'x', is_todo: 1 })), true);
assert.strictEqual(d.isOpenTodo(note({ id: 'x', is_todo: 1, todo_completed: 1 })), false);
assert.strictEqual(d.isOpenTodo(note({ id: 'x' })), false);

// Within a bucket, soonest first.
const sorted = buckets.today.map(n => n.todo_due);
assert.deepStrictEqual(sorted, [...sorted].sort((x, y) => x - y));

// ===========================================================================
// Recently opened / Pinned (unchanged behaviour)
// ===========================================================================

const mru = ['plain', 'done', 'zz-deleted', 'pinned', 'today-15', 'tue-am', 'wed'];
assert.deepStrictEqual(
  d.recentNotes(notes, mru).map(n => n.id),
  ['plain', 'pinned', 'today-15', 'tue-am'],
  'MRU order kept; completed and deleted skipped; capped at 4',
);
assert.strictEqual(d.recentNotes(notes, []).length, 0);

assert.deepStrictEqual(d.nextMru(['x', 'y', 'z'], 'y'), ['y', 'x', 'z'], 'reopen moves to front');
assert.deepStrictEqual(d.nextMru([], 'x'), ['x']);
assert.strictEqual(d.nextMru(Array.from({ length: 60 }, (_, i) => `n${i}`), 'new').length, d.MRU_STORE_SIZE);

assert.deepStrictEqual(d.pinnedNotes(notes).map(n => n.id), ['pinned']);
assert.deepStrictEqual(
  d.pinnedNotes([
    note({ id: 'p1', title: 'Pinned todo 📌', is_todo: 1 }),
    note({ id: 'p2', title: '📌 Done', is_todo: 1, todo_completed: 1 }),
  ]).map(n => n.id),
  ['p1'],
  'completed pinned to-do excluded; plain notes included',
);

// ===========================================================================
// Formatting
// ===========================================================================

assert.strictEqual(d.formatDuration(0), 'now');
assert.strictEqual(d.formatDuration(45 * 60000), '45m');
assert.strictEqual(d.formatDuration(2 * 3600e3), '2h');
assert.strictEqual(d.formatDuration(2 * 3600e3 + 15 * 60000), '2h 15m');
assert.strictEqual(d.formatDuration(26 * 3600e3), '1d 2h');

assert.strictEqual(d.formatDue(at(2026, 8, MON, 16, 5), NOW), '16:05', 'same day -> time');
assert.strictEqual(d.formatDue(at(2026, 8, TUE, 8), NOW), 'Tue 08:00', 'within a week -> weekday');
assert.strictEqual(d.formatDue(at(2026, 10, 1, 12), NOW), '1 Oct', 'beyond a week -> date');
assert.strictEqual(d.formatDue(0, NOW), 'no date');
assert.strictEqual(d.formatAbsolute(at(2026, 8, MON, 9, 5)), 'Mon 24 Aug 09:05');

const overdueBadge = d.dueBadge(notes[0], NOW);
assert.ok(overdueBadge.includes('overdue') && overdueBadge.includes('nd-badge-overdue'), overdueBadge);
assert.ok(d.dueBadge(notes[1], NOW).includes('15:00'));
assert.ok(d.dueBadge(notes[6], NOW).includes('nd-badge-undated'), 'undated badge');

// ===========================================================================
// Rendering
// ===========================================================================

assert.strictEqual(d.escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');

const tricky = note({ id: 'x', title: 'Tricky <b>&"\'' });
assert.ok(d.renderItem(tricky, '').includes('&lt;b&gt;'));
assert.ok(!d.renderItem(tricky, '').includes('<b>'), 'raw markup from a title leaked');
assert.ok(d.renderItem(tricky, '').includes('draggable="true"'), 'items must be draggable');
assert.ok(d.renderItem(notes[1], 'today-15').includes('nd-item-selected'));
assert.ok(!d.renderItem(notes[1], 'zzz').includes('nd-item-selected'));
assert.ok(d.renderItem(notes[1], '').includes('data-note-id="today-15"'));

const html = d.renderPanel(notes, mru, 'today-15', NOW);

// Five sections, in order.
assert.strictEqual((html.match(/nd-section/g) || []).length, 5 + 3, 'sections + droppable classes');
const order = ['Today', 'Next workday', 'Later', 'Recently opened', 'Pinned'];
let cursor = -1;
for (const label of order) {
  const index = html.indexOf(label);
  assert.ok(index > cursor, `${label} out of order`);
  cursor = index;
}

// Only the three to-do sections are drop targets.
assert.deepStrictEqual(
  (html.match(/data-drop-bucket="([a-zA-Z]+)"/g) || []),
  ['data-drop-bucket="today"', 'data-drop-bucket="nextWorkday"', 'data-drop-bucket="later"'],
);

// The middle heading names the actual weekday.
assert.strictEqual(d.nextWorkdayLabel(NOW), 'Next workday · Tue');
assert.strictEqual(d.nextWorkdayLabel(at(2026, 8, FRI, 10)), 'Next workday · Mon');
assert.ok(html.includes('Next workday · Tue'));

// Counts match the buckets.
assert.deepStrictEqual((html.match(/nd-count">(\d+)</g) || []),
  ['nd-count">3<', 'nd-count">2<', 'nd-count">2<', 'nd-count">4<', 'nd-count">1<']);

// Empty state for every section.
const emptyHtml = d.renderPanel([], [], '', NOW);
assert.strictEqual((emptyHtml.match(/nd-empty/g) || []).length, 5);
// ...but the drop targets still exist, so you can drop onto an empty section.
assert.strictEqual((emptyHtml.match(/data-drop-bucket/g) || []).length, 3);

// ===========================================================================
// Trashed & conflict notes must never render
// ===========================================================================

const dirty = [
  note({ id: 'clean', title: '📌 Keep me' }),
  note({ id: 'trash', title: '📌 Trashed', deleted_time: NOW }),
  note({ id: 'conf', title: '📌 Conflict', is_conflict: 1 }),
  note({ id: 'trashdue', title: 'Trashed due', is_todo: 1, todo_due: at(2026, 8, MON, 11), deleted_time: NOW }),
  note({ id: 'confdue', title: 'Conflict due', is_todo: 1, todo_due: at(2026, 8, MON, 11), is_conflict: 1 }),
];
assert.strictEqual(d.isVisibleNote(dirty[0]), true);
assert.strictEqual(d.isVisibleNote(dirty[1]), false);
assert.strictEqual(d.isVisibleNote(dirty[2]), false);

const dirtyHtml = d.renderPanel(dirty, ['trash', 'conf', 'clean'], '', NOW);
for (const id of ['trash', 'conf', 'trashdue', 'confdue']) {
  assert.ok(!dirtyHtml.includes(`data-note-id="${id}"`), `${id} leaked into the panel`);
}
assert.ok(dirtyHtml.includes('data-note-id="clean"'), 'visible note went missing');

console.log(`All assertions passed (${roundTrips} drop round-trips verified).`);
