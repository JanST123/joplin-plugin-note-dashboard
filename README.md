# Joplin Note Dashboard

A sidebar panel that surfaces the notes and to-dos you actually need right now.
Every entry opens its note on click, and the three to-do sections accept drops to
reschedule.

## Sections

| # | Section | Contents |
|---|---------|----------|
| 1 | **Today** | Open to-dos that are overdue, or due at/before today's 18:00 cutoff. Overdue entries sort first with a red badge. |
| 2 | **Next workday · \<day\>** | Due after today's cutoff, up to the next workday's cutoff. The heading names the actual weekday. |
| 3 | **Later** | Due beyond that, plus to-dos with **no due date** (shown last, marked *no date*). |
| 4 | **Recently opened** | The last 4 notes or to-dos you opened. |
| 5 | **Pinned** | Any note whose title contains 📌 — to-dos *and* plain notes. |

Completed to-dos are hidden from every section. Trashed notes and sync conflict
copies never appear.

## Rescheduling by drag and drop

Drag any row onto one of the first three sections:

| Drop target | Effect |
|---|---|
| **Today** | due today at 16:00 |
| **Next workday** | due next workday at 08:00 — Friday drops land on **Monday**, not Saturday |
| **Later** | clears the due date; the to-do stays visible in *Later* as undated |

Dragging a **plain note** into Today or Next workday converts it to a to-do
(`is_todo = 1`) as well as setting the date. Notes can also be dragged in from
Joplin's own note list, which publishes `text/x-jop-note-ids` — see the caveat
below. There is no confirmation step, and no undo.

### Why the bands are shaped this way

The obvious spec — "Today = due within 8h, Tomorrow = 8–36h" — is broken, because
those are rolling windows while *today* and *tomorrow* are calendar words. They
disagree for 7 of 25 sampled time/due combinations. At 07:00 a to-do due **today
at 18:00** is 11h away and would show under *Tomorrow*.

It breaks worse at the drop targets, which are wall-clock: drop onto *Today* at
07:00 and you get 16:00, which is 9h away — so the row immediately jumps to the
*next* section. That is the bug this design exists to avoid.

So both the section boundaries and the drop dates are anchored to the same
calendar model, and the middle band runs to the **next workday's** cutoff rather
than to tomorrow's. Otherwise a Friday drop (Monday 08:00) would land in *Later*.
On a Friday that band also absorbs anything due Sat/Sun, so nothing is stranded.

`npm test` verifies the resulting invariant exhaustively: **a to-do dropped on a
section always lands in that section**, across 400 consecutive days × every hour
× all three buckets (28,800 cases, covering both DST transitions).

### Known rough edges

- Dropping on **Today** after 16:00 sets a time in the past, so the to-do is
  immediately overdue and Joplin may fire its alarm at once. It stays in *Today*,
  which is arguably the honest signal, but it is a deliberate choice rather than
  an oversight.
- A to-do due **this evening** (after 18:00) appears under *Next workday*. That
  is the cost of the working-day cutoff; the badge shows the real time, so it is
  visible rather than misleading.
- Dragging **from Joplin's note list** into the panel is implemented but
  **unverified**. Panels are same-process iframes, so it should work; if it turns
  out not to, dragging within the panel is unaffected.

## How "recently opened" works

Joplin has no built-in recently-viewed history, so the plugin keeps its own. It
listens to `workspace.onNoteSelectionChange` and records a note when it is
selected on its own (a multi-note selection is a list operation, not a read). The
list is persisted in a private plugin setting, so it survives restarts.

- **The section is empty on first run** and fills in as you click around.
- Up to 40 IDs are stored although only 4 are shown, so the section stays full
  even when recent entries get deleted or ticked off.

## Refreshing

The panel redraws on note change, note selection, sync completion, alarm trigger,
and a 60-second timer — the timer matters because the section boundaries are
wall-clock times that pass without any activity in the app. Redraws are debounced
and never overlap.

## Build

```bash
npm install     # also builds, via the prepare hook
npm run dist    # -> publish/com.jstuhlmann.notedashboard.jpl
npm test        # section rules, drop round-trips, rendering
```

## Layout

```
src/index.ts        Joplin wiring: panel, events, settings, commands, drop handling
src/dashboard.ts    Pure logic: calendar maths, bucketing, drop dates, rendering
src/webview.js      Click, keyboard and drag-and-drop inside the panel webview
src/webview.css     Styling, themed via Joplin's CSS variables
tests/              Assertions against src/dashboard.ts
api/                Joplin plugin API type stubs (from generator-joplin)
```

`src/dashboard.ts` deliberately imports nothing from `api`, which is what makes
the rules testable without a running Joplin.

## Tuning

Constants at the top of `src/dashboard.ts` — change and rebuild; they are not
exposed as user settings:

| Constant | Default | Meaning |
|---|---|---|
| `DAY_CUTOFF_HOUR` | 18 | End of the working day |
| `TODAY_DROP_HOUR` | 16 | Time set by a drop on *Today* |
| `NEXT_WORKDAY_DROP_HOUR` | 8 | Time set by a drop on *Next workday* |
| `RECENT_COUNT` | 4 | Rows in *Recently opened* |
| `PIN_EMOJI` | 📌 | Pin marker matched in titles |

Note that `todo_due` **is** the alarm in Joplin, so every reschedule also moves
the notification.

## Implementation note

Section 5 scans note titles in JS rather than using the search API: Joplin's
full-text search tokeniser drops symbols, so `search?query=📌` returns nothing.
One paginated pass over the note list feeds all five sections.
