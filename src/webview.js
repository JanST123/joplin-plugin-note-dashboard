// Runs inside the panel webview. The panel HTML is replaced wholesale on every
// refresh, so listeners are delegated from `document` rather than bound per item.

// Our own drag format. Joplin's note list publishes `text/x-jop-note-ids`
// (a JSON array), which lets notes be dragged in from the note list too.
const OWN_FORMAT = 'text/x-note-dashboard-ids';
const JOPLIN_FORMAT = 'text/x-jop-note-ids';

function itemFromEvent(event) {
	return event.target.closest ? event.target.closest('.nd-item') : null;
}

function noteIdFromEvent(event) {
	const item = itemFromEvent(event);
	return item && item.dataset ? item.dataset.noteId : null;
}

// --- Opening notes ----------------------------------------------------------

document.addEventListener('click', event => {
	const noteId = noteIdFromEvent(event);
	if (noteId) webviewApi.postMessage({ name: 'openNote', id: noteId });
});

document.addEventListener('keydown', event => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	const noteId = noteIdFromEvent(event);
	if (!noteId) return;
	event.preventDefault();
	webviewApi.postMessage({ name: 'openNote', id: noteId });
});

// --- Dragging ---------------------------------------------------------------

document.addEventListener('dragstart', event => {
	const item = itemFromEvent(event);
	const noteId = item && item.dataset ? item.dataset.noteId : null;
	if (!noteId) return;
	event.dataTransfer.setData(OWN_FORMAT, JSON.stringify([noteId]));
	// Some hosts refuse a drag with no text/plain payload.
	event.dataTransfer.setData('text/plain', noteId);
	event.dataTransfer.effectAllowed = 'move';
	item.classList.add('nd-item-dragging');
});

document.addEventListener('dragend', event => {
	const item = itemFromEvent(event);
	if (item) item.classList.remove('nd-item-dragging');
	clearDropHighlight();
});

function readNoteIds(dataTransfer) {
	for (const format of [OWN_FORMAT, JOPLIN_FORMAT]) {
		const raw = dataTransfer.getData(format);
		if (!raw) continue;
		try {
			const ids = JSON.parse(raw);
			if (Array.isArray(ids) && ids.length) return ids.filter(id => typeof id === 'string');
		} catch (error) {
			console.warn('Note Dashboard: could not parse drag payload', format, error);
		}
	}
	return [];
}

// `dragover`/`dragenter` cannot read dataTransfer contents (the drag data store
// is in protected mode), only the type list — so acceptance is decided by type.
function dragHasNotes(dataTransfer) {
	const types = dataTransfer ? Array.from(dataTransfer.types || []) : [];
	return types.includes(OWN_FORMAT) || types.includes(JOPLIN_FORMAT);
}

function dropTargetFromEvent(event) {
	return event.target.closest ? event.target.closest('[data-drop-bucket]') : null;
}

let highlighted = null;

function clearDropHighlight() {
	if (highlighted) highlighted.classList.remove('nd-section-dragover');
	highlighted = null;
}

function setDropHighlight(section) {
	if (highlighted === section) return;
	clearDropHighlight();
	highlighted = section;
	if (section) section.classList.add('nd-section-dragover');
}

document.addEventListener('dragover', event => {
	const section = dropTargetFromEvent(event);
	if (!section || !dragHasNotes(event.dataTransfer)) return;
	// Preventing default is what marks this as a valid drop target.
	event.preventDefault();
	event.dataTransfer.dropEffect = 'move';
	setDropHighlight(section);
});

document.addEventListener('dragleave', event => {
	const section = dropTargetFromEvent(event);
	// Ignore leave events fired while moving between children of the same section.
	if (section && section.contains(event.relatedTarget)) return;
	if (section === highlighted) clearDropHighlight();
});

document.addEventListener('drop', event => {
	const section = dropTargetFromEvent(event);
	if (!section) return;
	event.preventDefault();
	clearDropHighlight();
	const noteIds = readNoteIds(event.dataTransfer);
	if (!noteIds.length) return;
	webviewApi.postMessage({
		name: 'setDue',
		bucket: section.dataset.dropBucket,
		noteIds,
	});
});
