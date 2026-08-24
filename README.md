# Joplin Note Dashboard

A sidebar panel that surfaces the notes and to-dos you actually need right now.
Every entry is clickable and opens the note in the editor.

## Sections

| # | Section | Contents |
|---|---------|----------|
| 1 | **Due within 8h** | To-dos whose alarm (`todo_due`) falls before *now + 8 hours*. **Overdue to-dos are included** and shown first with a red `Xh overdue` badge. Sorted soonest-first. |
| 2 | **Recently opened** | The last 4 notes or to-dos you opened. |
| 3 | **Pinned** | Any note whose **title** contains 📌 — to-dos *and* plain notes. Sorted by title. |

Completed to-dos are hidden from all three sections. Trashed notes and sync
conflict copies never appear.

## How "recently opened" works

Joplin has no built-in recently-viewed history, so the plugin keeps its own.
It listens to `workspace.onNoteSelectionChange` and records a note when it is
selected on its own (a multi-note selection is a list operation, not a read).
The list is persisted in a private plugin setting, so it survives restarts.

Two consequences worth knowing:

- **The section is empty on first run** and fills in as you click around.
- Up to 40 IDs are stored although only 4 are shown, so the section stays full
  even when recent entries get deleted or ticked off.

## Refreshing

The panel redraws when a note changes, when a note is selected, when a sync
finishes, when an alarm fires, and on a 60-second timer — the last one matters
because the 8-hour window slides forward on its own even when nothing happens in
the app. Redraws are debounced and never overlap.

## Build

```bash
npm install          # also builds, via the prepare hook
npm run dist         # build -> dist/ and publish/*.jpl
npm test             # assertions over the section-selection and rendering logic
```

`npm run dist` produces `publish/com.jstuhlmann.notedashboard.jpl`.

## Install

**From the built file:** Joplin → *Tools → Options → Plugins* → gear icon →
*Install from file* → pick `publish/com.jstuhlmann.notedashboard.jpl`.

**For development:** Joplin → *Tools → Options → Plugins* → *Advanced settings* →
set **Development plugins** to this repo's directory, then restart Joplin. It
will load `dist/` directly, so `npm run dist` + restart picks up changes.

Show or hide the panel from **View → Toggle Note Dashboard**. If you don't see
it, use *View → Change application layout* to move or resize the panel.

## Layout

```
src/index.ts        Joplin wiring: panel, events, settings, commands
src/dashboard.ts    Pure logic: section selection + HTML rendering (no api import)
src/webview.js      Click/keyboard handling inside the panel webview
src/webview.css     Styling, themed via Joplin's CSS variables
tests/              Assertions against src/dashboard.ts
api/                Joplin plugin API type stubs (from generator-joplin)
```

`src/dashboard.ts` deliberately imports nothing from `api`, which is what makes
the section rules testable without a running Joplin.

## Notes on implementation choices

- **Section 3 scans note titles in JS** rather than using the search API.
  Joplin's full-text search tokeniser drops symbols, so `search?query=📌`
  returns nothing. One paginated pass over the note list feeds all three
  sections.
- **The 8h window and the count of 4 are constants** in `src/dashboard.ts`
  (`DUE_WINDOW_MS`, `RECENT_COUNT`) — change and rebuild. They are not exposed
  as user settings.
