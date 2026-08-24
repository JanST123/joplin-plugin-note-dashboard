// Runs inside the panel webview. The panel HTML is replaced wholesale on every
// refresh, so listeners are delegated from `document` rather than bound per item.

function noteIdFromEvent(event) {
	const item = event.target.closest ? event.target.closest('.nd-item') : null;
	return item && item.dataset ? item.dataset.noteId : null;
}

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
