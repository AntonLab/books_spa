---
paths:
  - 'client/src/components/**'
---

# Component traps

What each component renders is in its file and its test. These are the parts
that read like mistakes and are not.

## antd menus (`AppHeader`)

- The nav `Menu` carries `disabledOverflow`: rc-menu keeps every child past the
  first `overflowDisabled` until `ResizeObserver` measures a width, which jsdom
  never does, so without it the Genres `SubMenu` is dead in tests. The price:
  the nav no longer collapses into "…" at phone width.
- `triggerSubMenuAction="click"`: a touch device cannot hover, and a test could
  only drive hover through rc-menu's open delay.
- The signed-out "Log in" menu carries `disabledOverflow` for its own reason: a
  menu sized by its single item collapses into "…" in any environment.
- Genre items are keyed by their target path (`searchPath`, so
  `/search?genre=<id>`) so a click navigates to its key like every other item,
  and `selectedKeys` compares `pathname + search`: `searchPath` must keep
  writing exactly what the search page's URL holds. The submenu is left out
  while Genres load, on error and when there are none. A Genre with Subgenres
  is a nested submenu (key `genre-<id>`) whose first entry is the Genre's own
  link.
- No Register item: the login modal's "Create an account" is the way in.

## Comments (`CommentSection`, `Comment`)

- The server returns a flat page; `CommentSection` builds the two-level tree,
  so there is no recursive component. A reply's Reply files the new reply
  under their root (`parentId` of the root), quoting the reply in the
  composer; the Unsaved text is keyed by the reply. Replies under a
  tombstoned root get no Reply, since the server refuses a Tombstone parent.
- `Comment` clamps its text to 3 lines behind "Show more" / "Show less"
  (antd `ellipsis`); the composer's quote passes `clamp={false}`. jsdom
  measures nothing, so the clamp is checked in a browser only.
- **It drops a tombstone with no live replies.** A tombstone earns its place
  only by keeping live replies in their thread, so a tombstoned root survives
  with at least one live direct reply, and a tombstoned reply never does.
- A surviving tombstone renders as `TOMBSTONE_LABELS` text with no Owner, no
  avatar and no controls, for anyone. Comment actions are `IconButton`s. Report
  shows to a signed-in non-Owner. A Moderator gets Remove (behind a confirm) on
  another Account's live Comment and Restore on a Removed one, both through
  `IconButton`; Removed Tombstones show to Moderators only, as a reply and as a
  root.
- `ReportActions` and `ReportedAccountCell` are molecules of the Reports table;
  like `GenreManager` they confirm destructive actions (`Popconfirm`) and show
  a disabled-with-a-reason tooltip.
- Edit, delete and like render only when the server would allow them; the
  server refuses each with 403 regardless. `closed` (a Draft book) makes the
  section read-only.
- The composer is one `CommentComposerModal`, opened by "Add comment" beside
  the heading, a Comment's Reply or its Edit; one `composing` state holds the
  mode, so at most one is open. A reply shows its target read-only above the
  field (`Comment` with every flag off). The modal is mounted only while open,
  focuses its field in `afterOpenChange` with the cursor at the end, and
  shows a failed send from the mutation's state, reset on each opening. The
  heading renders in every state so the section keeps its place.
- The molecule may be called `Comment` because antd removed its own in v5.
- The composer has no local state: its value is the Unsaved text entry of the
  open composer (root, reply or edit), or the saved Comment while an edit has
  none. Opening Edit writes nothing; clearing the field keeps an empty entry,
  so the saved text does not come back. A send clears the entry only on
  success; Cancel keeps it. A reply or edit whose target is gone or a
  Tombstone closes (reset during render, so a restored target does not reopen
  it), and its text shows as an `UnsavedTextNotice`.

## Cards (`Card`, `BookCard`, `SeriesCard`)

- A `tile` puts the media above the text and links it too, with
  `aria-hidden` and `tabIndex={-1}`: the Cover's image is `alt=""`, so a
  reachable Cover link would have no name and repeat the title's link. A tile
  shows no genre or tags; BookCard also drops the description and date.
  A Series has a Cover (`coverUrl`, `PUT`/`DELETE`/`GET /:id/cover`); its tile keeps the description.

## Images (`BookCover`, `AccountAvatar`, `ImageUploadButton`)

- `BookCover`'s image is `alt=""` (the title always sits beside it). A failed
  load falls back to the title placeholder, and a new `?v=` URL gets a fresh
  try rather than staying stuck on an old failure.
- `AccountAvatar` is decorative end to end (`aria-hidden`, `alt=""`) because a
  name sits beside it everywhere but `ProfilePage`, under the "Profile" heading.
- `ImageUploadButton` prechecks type and size against `shared`'s limits and
  makes no query call; each caller wires its own mutation.

## Forms and pickers

- Toasts come from `App.useApp().message`, never antd's static `message` or
  `notification`: statics skip the ConfigProvider theme. The holder lives in
  `App`, so a toast outlives the modal that fired it.
- Every modal holding a form uses `DiscardGuardModal`, except
  `CommentComposerModal` and `ChapterEditorModal` (their text is Unsaved
  text). Pass `form` only while the `Form` is mounted. A successful submit
  calls `onClose` itself and so skips the guard.
- `BookForm` / `SeriesForm`: the Series select is a `ClearableSelect` and the
  Genre select a `GenreTreeSelect` (a tree of Genres and Subgenres, any node
  choosable). Both are `allowClear`; antd shows the icon only on hover and it
  takes no focus, so the shared `useClearable` hook
  (`client/src/hooks/useClearable.ts`) makes each keep the icon visible and
  clear on Delete or Backspace while closed and stay closed, with "No series" /
  "No genre" as placeholders, not options. An empty or
  cleared select is `undefined` inside the form and leaves as an explicit
  `null` (the server accepts `null` for both). A stored `null` is seeded as
  `undefined`, since a select shows its placeholder only for that. Creating
  omits the status radios: every new book is a draft.
- `CoAuthorManager`'s picker draws avatars through `optionRender`; the option's
  `label` stays a plain string so antd's tooltip and rc-select's filter still
  work. The last Co-author is never offered Leave.
- Chapter publishing: "Publish" sends `'now'` or the picked moment as a UTC
  instant, "Save draft" sends `null`; a Published chapter gets "Save" (no
  `publishedAt`) and "Return to draft". `dayjs` is a direct dependency because
  the antd pickers take its objects.
- `AuthModals` mounts only the open modal. `AppHeader` owns which one is open,
  and the modals switch through `onOpen`; the reset-confirm modal is opened by
  the URL alone, never by state. `RegisterModal`'s "I'm author" maps to
  `role: 'author' | 'user'`, the two `REGISTRABLE_ROLES`.
- `LikeButton` takes the viewer's like id, not a boolean, so a second click
  deletes the right row.
- `FavoriteButton` has the same id-in, id-out shape but draws a star icon.
  It shows to Co-authors too (a Favorite asks for news, it is not praise) and
  never on a Draft, whose Favorites the server neither counts nor lists.
- `EmailNotificationsSetting`'s switch id `email-notifications` is the anchor
  the announcement emails link to; it scrolls itself into view for that hash,
  since the browser's own hash scroll runs before the SPA draws it.
- Icons come from `@ant-design/icons` (ADR-0012). Each renders `role="img"`
  named after itself: an icon beside visible text takes `aria-hidden`, and an
  icon-only control takes `aria-label` on the control (or on the icon, for a
  `Segmented` option).
- `NotificationBell` marks unread items read when opened but keeps them
  highlighted until it closes. It holds the Account's notification stream
  (`useNotificationStream`) and toasts each pushed Notification under the key
  `notification-<id>`, so a merged New chapter updates its toast. `AppHeader`
  keys it by the Account, so an Account switch drops the old toasts. A read
  row leaves the open popover when `readAt` plus `NOTIFICATION_READ_TTL_MS`
  passes: a per-row timer collapses it, then drops it, waiting at most the TTL
  so a browser clock behind the server cannot hold a row longer. Rows already expired in
  a stale cache are filtered at render. The Popover is `destroyOnHidden`:
  antd keeps hidden content mounted otherwise, and the row timers would keep
  running.

## Sortable lists (`SortableList`)

- `@dnd-kit` through a drag handle named "Reorder {label}": `PointerSensor` for
  the mouse, `KeyboardSensor` for Space, arrows, Space.
- `onReorder` fires with the whole new order, only when a drop moved something.
- An `<ol>` with markers hidden: order is shown by place, never by number.
  Announcements name items by label, not id.
