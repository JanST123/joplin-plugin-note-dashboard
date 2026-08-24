/**
 * Pure dashboard logic: which notes belong in which section, what a drop does,
 * and how the panel is rendered. Deliberately free of any `api` import so it can
 * be exercised without a running Joplin.
 */

// --- Tuning constants -------------------------------------------------------

/**
 * End of the working day. A to-do due after this hour counts as belonging to the
 * next working day rather than to today.
 */
export const DAY_CUTOFF_HOUR = 18;
/** Dropping onto "Today" schedules for this hour. */
export const TODAY_DROP_HOUR = 16;
/** Dropping onto "Next workday" schedules for this hour. */
export const NEXT_WORKDAY_DROP_HOUR = 8;

export const RECENT_COUNT = 4;
// Keep more IDs than we display: entries whose note was deleted or completed get
// skipped at render time, and the surplus keeps the section full anyway.
export const MRU_STORE_SIZE = 40;
export const PIN_EMOJI = '📌';

export interface Note {
	id: string;
	title: string;
	is_todo: number;
	todo_completed: number;
	todo_due: number;
	// Present when requested from the data API; treated as absent-means-zero so
	// callers that build Notes by hand stay valid.
	deleted_time?: number;
	is_conflict?: number;
}

export type Bucket = 'today' | 'nextWorkday' | 'later';
export const BUCKETS: Bucket[] = ['today', 'nextWorkday', 'later'];

export function isBucket(value: unknown): value is Bucket {
	return typeof value === 'string' && (BUCKETS as string[]).includes(value);
}

// --- Calendar helpers -------------------------------------------------------
//
// All of these go through Date's calendar methods rather than adding fixed
// millisecond offsets, so a day that is 23 or 25 hours long across a DST
// transition still counts as one day.

export function addDays(timestamp: number, days: number): number {
	const date = new Date(timestamp);
	date.setDate(date.getDate() + days);
	return date.getTime();
}

/** The given day at `hour`:00:00.000 local time. */
export function atHour(timestamp: number, hour: number): number {
	const date = new Date(timestamp);
	date.setHours(hour, 0, 0, 0);
	return date.getTime();
}

export function isWeekend(timestamp: number): boolean {
	const day = new Date(timestamp).getDay();
	return day === 0 || day === 6;
}

export function isSameDay(a: number, b: number): boolean {
	const dateA = new Date(a);
	const dateB = new Date(b);
	return dateA.getFullYear() === dateB.getFullYear()
		&& dateA.getMonth() === dateB.getMonth()
		&& dateA.getDate() === dateB.getDate();
}

/** The next day that is not a Saturday or Sunday. */
export function nextWorkday(now: number): number {
	let candidate = addDays(now, 1);
	while (isWeekend(candidate)) candidate = addDays(candidate, 1);
	return candidate;
}

// --- Bucketing --------------------------------------------------------------

/**
 * Which section an open to-do belongs to.
 *
 *   today       overdue, or due at/before today's cutoff
 *   nextWorkday due after today's cutoff, up to the next workday's cutoff
 *   later       due after that, or no due date at all
 *
 * The middle band deliberately runs to the *next workday's* cutoff rather than
 * to tomorrow's. Dropping onto that section sets the next workday's morning, so
 * on a Friday a dropped to-do gets Monday — if membership stopped at "tomorrow"
 * it would land in `later` instead, i.e. not in the section it was dropped on.
 * Tying both to `nextWorkday` keeps drops round-trip consistent, and on a Friday
 * the band also absorbs anything due over the weekend so nothing is stranded.
 */
export function bucketOf(due: number, now: number): Bucket {
	if (!due) return 'later';
	if (due < now) return 'today';
	if (due <= atHour(now, DAY_CUTOFF_HOUR)) return 'today';
	if (due <= atHour(nextWorkday(now), DAY_CUTOFF_HOUR)) return 'nextWorkday';
	return 'later';
}

/** The due date a drop onto `bucket` should set. Zero means "clear the date". */
export function dropDueDate(bucket: Bucket, now: number): number {
	if (bucket === 'today') return atHour(now, TODAY_DROP_HOUR);
	if (bucket === 'nextWorkday') return atHour(nextWorkday(now), NEXT_WORKDAY_DROP_HOUR);
	return 0;
}

export function isCompletedTodo(note: Note): boolean {
	return !!note.is_todo && !!note.todo_completed;
}

export function isOpenTodo(note: Note): boolean {
	return !!note.is_todo && !note.todo_completed;
}

/**
 * Trashed notes and conflict copies must never reach the panel. The data API's
 * default handling of these differs between endpoints and versions, so we filter
 * explicitly rather than relying on it.
 */
export function isVisibleNote(note: Note): boolean {
	return !note.deleted_time && !note.is_conflict;
}

/** Open to-dos grouped into the three time buckets, each sorted soonest-first. */
export function bucketTodos(notes: Note[], now: number): Record<Bucket, Note[]> {
	const result: Record<Bucket, Note[]> = { today: [], nextWorkday: [], later: [] };
	for (const note of notes) {
		if (!isOpenTodo(note)) continue;
		result[bucketOf(note.todo_due, now)].push(note);
	}
	for (const bucket of BUCKETS) {
		// Undated to-dos sort last within `later`, then by title.
		result[bucket].sort((a, b) => {
			if (!a.todo_due !== !b.todo_due) return a.todo_due ? -1 : 1;
			if (a.todo_due !== b.todo_due) return a.todo_due - b.todo_due;
			return (a.title || '').localeCompare(b.title || '');
		});
	}
	return result;
}

/** Any note — to-do or not — whose title contains the pin emoji. */
export function pinnedNotes(notes: Note[]): Note[] {
	return notes
		.filter(note => (note.title || '').includes(PIN_EMOJI) && !isCompletedTodo(note))
		.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

/** The most recently opened notes, in MRU order, skipping ones that no longer qualify. */
export function recentNotes(notes: Note[], mru: string[]): Note[] {
	const byId = new Map(notes.map(note => [note.id, note]));
	const result: Note[] = [];
	for (const id of mru) {
		const note = byId.get(id);
		// Skip notes deleted since we recorded them, and completed to-dos.
		if (!note || isCompletedTodo(note)) continue;
		result.push(note);
		if (result.length >= RECENT_COUNT) break;
	}
	return result;
}

/** Moves `noteId` to the front of the MRU list, capped at `MRU_STORE_SIZE`. */
export function nextMru(mru: string[], noteId: string): string[] {
	return [noteId, ...mru.filter(id => id !== noteId)].slice(0, MRU_STORE_SIZE);
}

// --- Formatting -------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	'\'': '&#39;',
};

export function escapeHtml(value: string): string {
	return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value: number): string {
	return value < 10 ? `0${value}` : `${value}`;
}

export function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60000);
	if (minutes < 1) return 'now';
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
}

/** Deliberately not `toLocaleString`: a stable format keeps the tests meaningful. */
export function formatAbsolute(timestamp: number): string {
	const date = new Date(timestamp);
	return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Short badge text: time for today, weekday+time within a week, date beyond. */
export function formatDue(due: number, now: number): string {
	if (!due) return 'no date';
	const date = new Date(due);
	const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	if (isSameDay(due, now)) return time;
	if (due > now && due < addDays(now, 7)) return `${WEEKDAYS[date.getDay()]} ${time}`;
	return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function dueBadge(note: Note, now: number): string {
	if (!note.todo_due) return '<span class="nd-badge nd-badge-undated">no date</span>';
	const absolute = escapeHtml(formatAbsolute(note.todo_due));
	if (note.todo_due < now) {
		return `<span class="nd-badge nd-badge-overdue" title="${absolute}">${escapeHtml(formatDuration(now - note.todo_due))} overdue</span>`;
	}
	return `<span class="nd-badge" title="${absolute}">${escapeHtml(formatDue(note.todo_due, now))}</span>`;
}

// --- Rendering --------------------------------------------------------------

export function renderItem(note: Note, selectedNoteId: string, badge = ''): string {
	const classes = ['nd-item'];
	if (note.id === selectedNoteId) classes.push('nd-item-selected');
	if (note.is_todo) classes.push('nd-item-todo');
	const marker = note.is_todo
		? '<span class="nd-marker">☐</span>'
		: '<span class="nd-marker nd-marker-note">•</span>';
	const title = escapeHtml(note.title || '(Untitled)');
	return `<div class="${classes.join(' ')}" data-note-id="${escapeHtml(note.id)}" draggable="true" role="button" tabindex="0" title="${title}">${marker}<span class="nd-title">${title}</span>${badge}</div>`;
}

export function renderSection(
	title: string,
	icon: string,
	items: string[],
	emptyText: string,
	dropBucket: Bucket | null = null,
): string {
	const body = items.length ? items.join('') : `<div class="nd-empty">${escapeHtml(emptyText)}</div>`;
	const dropAttrs = dropBucket ? ` data-drop-bucket="${dropBucket}"` : '';
	const dropClass = dropBucket ? ' nd-section-droppable' : '';
	return `<section class="nd-section${dropClass}"${dropAttrs}>`
		+ '<h3 class="nd-heading">'
		+ `<span class="nd-heading-icon">${icon}</span>`
		+ `<span class="nd-heading-text">${escapeHtml(title)}</span>`
		+ `<span class="nd-count">${items.length}</span>`
		+ `</h3>${body}</section>`;
}

/** Heading for the middle section, e.g. "Next workday · Mon". */
export function nextWorkdayLabel(now: number): string {
	return `Next workday · ${WEEKDAYS[new Date(nextWorkday(now)).getDay()]}`;
}

export function renderPanel(allNotes: Note[], mru: string[], selectedNoteId: string, now: number): string {
	const notes = allNotes.filter(isVisibleNote);
	const todos = bucketTodos(notes, now);
	const recent = recentNotes(notes, mru);
	const pinned = pinnedNotes(notes);

	const todoItems = (bucket: Bucket) =>
		todos[bucket].map(note => renderItem(note, selectedNoteId, dueBadge(note, now)));

	return '<div class="nd-root">'
		+ renderSection('Today', '⏰', todoItems('today'), 'Nothing due today.', 'today')
		+ renderSection(nextWorkdayLabel(now), '📅', todoItems('nextWorkday'), 'Nothing queued.', 'nextWorkday')
		+ renderSection('Later', '🗓', todoItems('later'), 'Nothing further out.', 'later')
		+ renderSection(
			'Recently opened',
			'🕘',
			recent.map(note => renderItem(note, selectedNoteId)),
			'No notes opened yet.',
		)
		+ renderSection(
			'Pinned',
			'📌',
			pinned.map(note => renderItem(note, selectedNoteId)),
			`No note titles contain ${PIN_EMOJI}.`,
		)
		+ '</div>';
}
