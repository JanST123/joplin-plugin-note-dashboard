import joplin from 'api';
import { MenuItemLocation, SettingItemType } from 'api/types';
import { Note, nextMru, renderPanel } from './dashboard';

/**
 * Note Dashboard — a sidebar panel with three sections:
 *
 *   1. To-dos whose alarm falls within the next 8 hours (overdue ones included).
 *   2. The last 4 notes that were opened.
 *   3. Notes whose title contains 📌.
 *
 * Joplin exposes no "recently viewed" history, so section 2 is backed by our own
 * MRU list, maintained from `workspace.onNoteSelectionChange` and persisted in a
 * private plugin setting so it survives restarts.
 *
 * Section selection and rendering live in ./dashboard.ts; this file is only the
 * Joplin wiring.
 */

const PANEL_ID = 'noteDashboard.panel';
const MRU_SETTING = 'noteDashboard.recentNoteIds';

const NOTE_FIELDS = ['id', 'title', 'is_todo', 'todo_completed', 'todo_due', 'deleted_time', 'is_conflict'];
const PAGE_LIMIT = 100;
const MAX_PAGES = 500;
const REFRESH_DEBOUNCE_MS = 300;
// The 8h window slides even when nothing happens in the app, so re-render on a timer.
const TICK_MS = 60 * 1000;

// Section 3 has to match an emoji inside note titles. Joplin's full-text search
// tokeniser drops symbols, so `search?query=📌` finds nothing — we scan titles
// ourselves instead. The same pass feeds all three sections, so a refresh stays
// one walk over the note list.
async function fetchAllNotes(): Promise<Note[]> {
	const notes: Note[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await joplin.data.get(['notes'], {
			fields: NOTE_FIELDS,
			limit: PAGE_LIMIT,
			page,
		});
		if (response?.items?.length) notes.push(...response.items);
		if (!response?.has_more) break;
	}
	return notes;
}

async function loadMru(): Promise<string[]> {
	const value = await joplin.settings.value(MRU_SETTING);
	return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
}

joplin.plugins.register({
	onStart: async function () {
		await joplin.settings.registerSettings({
			[MRU_SETTING]: {
				value: [],
				type: SettingItemType.Array,
				public: false,
				label: 'Recently opened note IDs',
			},
		});

		const panel = await joplin.views.panels.create(PANEL_ID);
		await joplin.views.panels.addScript(panel, './webview.css');
		await joplin.views.panels.addScript(panel, './webview.js');

		let selectedNoteId = '';

		const drawPanel = async () => {
			const [notes, mru] = await Promise.all([fetchAllNotes(), loadMru()]);
			await joplin.views.panels.setHtml(panel, renderPanel(notes, mru, selectedNoteId, Date.now()));
		};

		// Refreshes are debounced and never overlap: a request arriving mid-draw is
		// coalesced into a single follow-up draw, so an event burst costs one extra pass.
		let refreshTimer: any = null;
		let drawing = false;
		let redrawQueued = false;

		const scheduleRefresh = (delay = REFRESH_DEBOUNCE_MS) => {
			if (refreshTimer) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				void refresh();
			}, delay);
		};

		const refresh = async () => {
			if (drawing) {
				redrawQueued = true;
				return;
			}
			drawing = true;
			try {
				await drawPanel();
			} catch (error) {
				console.error('Note Dashboard: failed to refresh panel', error);
			} finally {
				drawing = false;
				if (redrawQueued) {
					redrawQueued = false;
					scheduleRefresh();
				}
			}
		};

		await joplin.views.panels.onMessage(panel, async (message: any) => {
			if (message?.name === 'openNote' && message.id) {
				await joplin.commands.execute('openNote', message.id);
			} else if (message?.name === 'refresh') {
				await refresh();
			}
		});

		await joplin.workspace.onNoteSelectionChange(async ({ value }) => {
			// Only a single-note selection counts as "opening" a note; a multi-selection
			// is a list operation, not a read.
			if (value?.length === 1) {
				selectedNoteId = value[0];
				const mru = await loadMru();
				if (mru[0] !== selectedNoteId) {
					await joplin.settings.setValue(MRU_SETTING, nextMru(mru, selectedNoteId));
				}
			} else {
				selectedNoteId = '';
			}
			scheduleRefresh();
		});

		// Titles, alarms and completion states all surface through onNoteChange.
		await joplin.workspace.onNoteChange(() => scheduleRefresh());
		await joplin.workspace.onSyncComplete(() => scheduleRefresh());
		await joplin.workspace.onNoteAlarmTrigger(() => scheduleRefresh());
		setInterval(() => scheduleRefresh(0), TICK_MS);

		await joplin.commands.register({
			name: 'noteDashboard.toggle',
			label: 'Toggle Note Dashboard',
			iconName: 'fas fa-thumbtack',
			execute: async () => {
				const visible = await joplin.views.panels.visible(panel);
				await joplin.views.panels.show(panel, !visible);
			},
		});
		await joplin.views.menuItems.create(
			'noteDashboard.toggleMenuItem',
			'noteDashboard.toggle',
			MenuItemLocation.View,
		);

		const initialSelection = await joplin.workspace.selectedNoteIds();
		if (initialSelection?.length === 1) selectedNoteId = initialSelection[0];
		await refresh();
	},
});
