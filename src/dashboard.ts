/**
 * Pure dashboard logic: which notes belong in which section, and how the panel
 * is rendered. Deliberately free of any `api` import so it can be exercised
 * without a running Joplin instance.
 */

export const DUE_WINDOW_MS = 8 * 60 * 60 * 1000;
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

/**
 * Trashed notes and conflict copies must never reach the panel. The data API's
 * default handling of these differs between endpoints and versions, so we filter
 * explicitly rather than relying on it.
 */
export function isVisibleNote(note: Note): boolean {
	return !note.deleted_time && !note.is_conflict;
}

// ---------------------------------------------------------------------------
// Section selection
// ---------------------------------------------------------------------------

export function isCompletedTodo(note: Note): boolean {
	return !!note.is_todo && !!note.todo_completed;
}

/** To-dos with an alarm before `now + 8h`, overdue ones included, soonest first. */
export function dueSoonNotes(notes: Note[], now: number): Note[] {
	const cutoff = now + DUE_WINDOW_MS;
	return notes
		.filter(note => !!note.is_todo && !note.todo_completed && !!note.todo_due && note.todo_due < cutoff)
		.sort((a, b) => a.todo_due - b.todo_due);
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

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

export function dueBadge(note: Note, now: number): string {
	const diff = note.todo_due - now;
	const absolute = escapeHtml(new Date(note.todo_due).toLocaleString());
	if (diff < 0) {
		return `<span class="nd-badge nd-badge-overdue" title="${absolute}">${escapeHtml(formatDuration(-diff))} overdue</span>`;
	}
	return `<span class="nd-badge" title="${absolute}">in ${escapeHtml(formatDuration(diff))}</span>`;
}

export function renderItem(note: Note, selectedNoteId: string, badge = ''): string {
	const classes = ['nd-item'];
	if (note.id === selectedNoteId) classes.push('nd-item-selected');
	if (note.is_todo) classes.push('nd-item-todo');
	const marker = note.is_todo
		? '<span class="nd-marker">☐</span>'
		: '<span class="nd-marker nd-marker-note">•</span>';
	const title = escapeHtml(note.title || '(Untitled)');
	return `<div class="${classes.join(' ')}" data-note-id="${escapeHtml(note.id)}" role="button" tabindex="0" title="${title}">${marker}<span class="nd-title">${title}</span>${badge}</div>`;
}

export function renderSection(title: string, icon: string, items: string[], emptyText: string): string {
	const body = items.length ? items.join('') : `<div class="nd-empty">${escapeHtml(emptyText)}</div>`;
	return `<section class="nd-section">`
		+ `<h3 class="nd-heading">`
		+ `<span class="nd-heading-icon">${icon}</span>`
		+ `<span class="nd-heading-text">${escapeHtml(title)}</span>`
		+ `<span class="nd-count">${items.length}</span>`
		+ `</h3>${body}</section>`;
}

export function renderPanel(allNotes: Note[], mru: string[], selectedNoteId: string, now: number): string {
	const notes = allNotes.filter(isVisibleNote);
	const dueSoon = dueSoonNotes(notes, now);
	const recent = recentNotes(notes, mru);
	const pinned = pinnedNotes(notes);

	return '<div class="nd-root">'
		+ renderSection(
			'Due within 8h',
			'⏰',
			dueSoon.map(note => renderItem(note, selectedNoteId, dueBadge(note, now))),
			'Nothing due in the next 8 hours.',
		)
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
