---
status: accepted
date: 2026-09-23
---

# Server state in TanStack Query, shared client state in Redux, the rest in components

The client keeps three kinds of state apart:

- **Server state.** Everything the server answers: Books, Chapters,
  Comments, the session. TanStack Query caches it in `src/queries/`.
  Nothing the server returns is copied anywhere else. A component that needs
  the signed-in Account reads the session query, so a changed Avatar or a
  Blocked Account cannot leave a stale second copy behind.
- **Shared client state.** State that outlives the component showing it and
  that the server never sees: Unsaved text, Device preferences and Recently
  viewed. It lives in Redux Toolkit.
- **Everything else stays in components.** Which auth modal is open belongs to
  `AppHeader`. The password-reset token is read from the URL, because the URL
  is where the emailed link carries it.

Using two libraries is deliberate. The project demonstrates each tool doing
the job it is built for.

## Considered Options

- **RTK Query for server state, dropping TanStack Query.** One library, but
  every hook in `src/queries/` would have to be rewritten, with no change in
  behaviour.
- **Context and `useReducer` for shared client state instead of Redux.**
  Unsaved text would then need its selectors, devtools and `localStorage`
  persistence built by hand.
- **Keeping the auth modals in Redux until then.** The one slice held two
  fields, and three of its four transitions were plain `setState` calls.

## Amendment (2026-11-02)

The inner Books/Series tab of `ProfileWorksPanel` lives in the URL
(`?tab=series`), not in component state, because each list keeps its filters
in the query string too. This is the one place the "everything else stays in
components" rule is bent; `.claude/rules/client/pages.md` records it.
