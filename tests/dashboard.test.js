// Run with: npm test
const assert = require('assert');
const d = require("../.test-build/dashboard.js");

const NOW = Date.parse('2026-08-24T12:00:00Z');
const H = 3600 * 1000;
const note = (o) => ({ id: o.id, title: o.title || '', is_todo: o.is_todo ?? 0, todo_completed: o.todo_completed ?? 0, todo_due: o.todo_due ?? 0 });

const notes = [
  note({ id: 'a', title: 'Due in 2h',        is_todo: 1, todo_due: NOW + 2 * H }),
  note({ id: 'b', title: 'Due in 7h59m',     is_todo: 1, todo_due: NOW + 8 * H - 60000 }),
  note({ id: 'c', title: 'Due in 8h01m',     is_todo: 1, todo_due: NOW + 8 * H + 60000 }),
  note({ id: 'd', title: 'Overdue 3h',       is_todo: 1, todo_due: NOW - 3 * H }),
  note({ id: 'e', title: 'Done, due in 1h',  is_todo: 1, todo_due: NOW + 1 * H, todo_completed: NOW }),
  note({ id: 'f', title: 'Todo, no alarm',   is_todo: 1, todo_due: 0 }),
  note({ id: 'g', title: 'Plain note' }),
  note({ id: 'h', title: '📌 Pinned note' }),
  note({ id: 'i', title: 'Pinned todo 📌',   is_todo: 1, todo_due: NOW + 40 * H }),
  note({ id: 'j', title: '📌 Done pinned',   is_todo: 1, todo_completed: NOW }),
  note({ id: 'k', title: 'Tricky <b>&"\'' }),
];

// --- Section 1: due within 8h ---
const due = d.dueSoonNotes(notes, NOW).map(n => n.id);
assert.deepStrictEqual(due, ['d', 'a', 'b'], `due-soon wrong: ${due}`);
// d(overdue) included and sorted first; c (8h01m) excluded; e (completed) excluded;
// f (no alarm) excluded; g/h (not todos) excluded.

// --- Section 2: last 4 opened ---
const mru = ['g', 'e', 'zz-deleted', 'h', 'a', 'b', 'c'];
const recent = d.recentNotes(notes, mru).map(n => n.id);
assert.deepStrictEqual(recent, ['g', 'h', 'a', 'b'], `recent wrong: ${recent}`);
// MRU order preserved; 'e' (completed todo) and 'zz-deleted' (gone) skipped; capped at 4.
assert.strictEqual(d.recentNotes(notes, []).length, 0);

// --- MRU maintenance ---
assert.deepStrictEqual(d.nextMru(['x', 'y', 'z'], 'y'), ['y', 'x', 'z'], 'reopen should move to front, not duplicate');
assert.deepStrictEqual(d.nextMru([], 'x'), ['x']);
assert.strictEqual(d.nextMru(Array.from({ length: 60 }, (_, i) => `n${i}`), 'new').length, d.MRU_STORE_SIZE);

// --- Section 3: pinned ---
const pinned = d.pinnedNotes(notes).map(n => n.id);
assert.deepStrictEqual(pinned, ['h', 'i'], `pinned wrong: ${pinned}`);
// Plain note 'h' included (pins are not todo-only); emoji matches anywhere in title;
// completed pinned todo 'j' excluded; 'g' has no pin.

// --- Duration formatting ---
assert.strictEqual(d.formatDuration(0), 'now');
assert.strictEqual(d.formatDuration(45 * 60000), '45m');
assert.strictEqual(d.formatDuration(2 * H), '2h');
assert.strictEqual(d.formatDuration(2 * H + 15 * 60000), '2h 15m');
assert.strictEqual(d.formatDuration(26 * H), '1d 2h');

// --- Badges ---
assert.ok(d.dueBadge(notes[0], NOW).includes('in 2h'));
const overdueBadge = d.dueBadge(notes[3], NOW);
assert.ok(overdueBadge.includes('3h overdue') && overdueBadge.includes('nd-badge-overdue'), overdueBadge);

// --- HTML escaping (titles are user data injected into panel HTML) ---
assert.strictEqual(d.escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
const html = d.renderPanel(notes, mru, 'a', NOW);
assert.ok(!html.includes('<b>'), 'raw <b> from a note title leaked into the panel HTML');
assert.ok(d.renderItem(notes[10], '').includes('&lt;b&gt;'));

// --- Selected-note highlight & note ids ---
assert.ok(d.renderItem(notes[0], 'a').includes('nd-item-selected'));
assert.ok(!d.renderItem(notes[0], 'zzz').includes('nd-item-selected'));
assert.ok(d.renderItem(notes[0], '').includes('data-note-id="a"'));

// --- Panel structure: three sections, correct counts ---
assert.strictEqual((html.match(/nd-section/g) || []).length, 3);
assert.ok(html.indexOf('Due within 8h') < html.indexOf('Recently opened'));
assert.ok(html.indexOf('Recently opened') < html.indexOf('Pinned'));
assert.deepStrictEqual((html.match(/nd-count">(\d+)</g) || []), ['nd-count">3<', 'nd-count">4<', 'nd-count">2<']);

// --- Empty state ---
const emptyHtml = d.renderPanel([], [], '', NOW);
assert.strictEqual((emptyHtml.match(/nd-empty/g) || []).length, 3);

console.log('All assertions passed.');

// --- Trashed & conflict notes must never render ---
const NOW2 = NOW;
const dirty = [
  note({ id: 'clean', title: '📌 Keep me' }),
  { ...note({ id: 'trash', title: '📌 Trashed' }), deleted_time: NOW2 },
  { ...note({ id: 'conf',  title: '📌 Conflict' }), is_conflict: 1 },
  { ...note({ id: 'trashdue', title: 'Trashed due', is_todo: 1, todo_due: NOW2 + H }), deleted_time: NOW2 },
];
assert.strictEqual(d.isVisibleNote(dirty[0]), true);
assert.strictEqual(d.isVisibleNote(dirty[1]), false);
assert.strictEqual(d.isVisibleNote(dirty[2]), false);

const dirtyHtml = d.renderPanel(dirty, ['trash', 'conf', 'clean'], '', NOW2);
assert.ok(!dirtyHtml.includes('data-note-id="trash"'), 'trashed note leaked into panel');
assert.ok(!dirtyHtml.includes('data-note-id="conf"'), 'conflict copy leaked into panel');
assert.ok(!dirtyHtml.includes('data-note-id="trashdue"'), 'trashed to-do leaked into due section');
assert.ok(dirtyHtml.includes('data-note-id="clean"'), 'visible note went missing');
// Pinned count must be 1, not 3.
assert.deepStrictEqual((dirtyHtml.match(/nd-count">(\d+)</g) || []), ['nd-count">0<', 'nd-count">1<', 'nd-count">1<']);

console.log('Trash/conflict assertions passed.');
