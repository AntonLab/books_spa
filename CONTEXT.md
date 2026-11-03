# Books Demo SPA

A reading platform: authors publish books chapter by chapter, and signed-in
readers comment on them and like them. What each person may do is governed by
their role.

## Language

### People and access

**Account**:
Any registered person, whatever their role. An Account signs in with its login
or its email; a login cannot contain `@`.
_Avoid_: User (for a registered person in general)

**Guest**:
Someone with no session: an anonymous visitor.
_Avoid_: Anonymous user

**Profile**:
An Account's own private page: its details, avatar, email-notification setting,
Favorites, Library, Reading lists and, for an Author, the works it is a
Co-author of. Only the Account itself sees it; what others see is its Public
profile.
_Avoid_: Settings, Account page, Cabinet

**Public profile**:
The page anyone, Guests included, sees for an Account: its Avatar, name, About
text, when it was last Online (unless it hides that), totals across its
Published works, and its Published Series and Books. Only an Active Account
has one; a Blocked or Pending Account's page redirects home, so its
name is shown as plain text.
_Avoid_: Profile (that one is private), author page

**Last online**:
When an Account was last seen signed in, accurate to five minutes. A Public
profile shows it as "Online now", "Last online today", "Last online yesterday"
or "Last online" with a date, and omits it when the Account hides it. Not the
same as Online, which is a live connection.
_Avoid_: Last seen, last active

**About**:
The plain text an Account writes about itself, up to 1000 characters, shown on
its Public profile. Empty means the Public profile has no About block.
_Avoid_: Bio, description (a Work has one of those)

**Role**:
The rank an Account holds: User, Author, Admin or Superadmin. Guest is the
role assumed for someone with no session; no Account holds it.

**Scope**:
How far a Role's grant on an action reaches: `none` refuses it, `own` limits
it to rows the Account owns, `any` reaches every row regardless of Owner.

**User**:
The entry-level Role: reads, comments and likes.
_Avoid_: "user" for any Account

**Author**:
The Role that may also publish Series, Books and Chapters, and the only Role an
Account must hold to be made a Co-author.
_Avoid_: "author" for whoever wrote a comment (its Owner) or for someone
credited on a Book (a Co-author)

**Co-author**:
An Account credited on a Work. Every credited Account is one, even
when it is the only one; all of a Work's Co-authors are equal, and a Work always
has at least one. A byline lists Co-authors in credit order; the order carries
no rank.
Removing a Co-author and adding them again moves them to the end.
_Avoid_: Primary author, creator, "author" for a credit

**Admin**:
The Role that moderates other people's content, manages User and Author
Accounts, and keeps the Genre list.

**Superadmin**:
The top Role, and the only one that reaches Admin and Superadmin Accounts.

**Owner**:
The Account a Comment or Like belongs to; whoever wrote a comment is its Owner.
A Work has no single Owner — each of its Co-authors owns it equally —
and a Chapter is owned by its Book's Co-authors.
_Avoid_: Author (for a comment's writer), creator

**Moderator**:
An Admin or Superadmin acting on content they do not own. A hat worn for one
action, not a Role. A Moderator never acts on Reports of its own Comment.
_Avoid_: treating Moderator as a Role

**Blocked**:
An Account status that refuses sign-in and ends the Account's existing
sessions.

**Sign out**:
An Account ending its own session on purpose. A session belongs to the device,
not to one open tab, so every tab becomes a Guest's; the Account's Unsaved text
on that device is discarded.
_Avoid_: Logout (the button's label, not a different event)

**Lost session**:
A session that ended without a Sign out: it expired, the Account was Blocked,
or its password was reset. Every tab on the device becomes a Guest's, but the
Account's Unsaved text is kept for when it signs back in.
_Avoid_: Sign out (for a session the Account did not end itself)

**Pending**:
An Account status reserved for a future email-verification step. A Pending
Account signs in like an Active one but has no Public profile
(`AccountRepository.findProfile`). Registration sets `active`
(`register` in `createAccountSession`), so no current Account is Pending.

**Avatar**:
The optional picture an Account shows beside its name, whatever its Role. An
Account without one is shown by its initials.
_Avoid_: Author photo, profile picture, userpic

### Content

**Book**:
A Work credited to one or more Co-authors, read as a sequence of Chapters in
its Reading order and optionally grouped into a Series.
_Avoid_: Title

**Work**:
A Book or a Series, named where a rule covers both.

**Description**:
The text a Work's Co-authors write to tell readers what it is
about. It may be empty.
_Avoid_: Annotation, summary, blurb

**Cover**:
The one optional picture that stands for a Work. One without it is
shown with a placeholder bearing its title; a Series never borrows a Cover from
its Books.
_Avoid_: Image, thumbnail, poster

**Illustration**:
A picture a Co-author attaches to a Chapter, with an optional caption. A
Chapter's Illustrations have an explicit order and follow the Chapter's
visibility: a Draft or Scheduled Chapter's are as hidden as its text.
_Avoid_: Image, attachment, figure, gallery

**Book status**:
Where a Book stands: Draft, In progress or Complete. Every Book has exactly one.
_Avoid_: State (for a Book)

**Draft book**:
A Book kept from readers; only its Co-authors and Moderators can see it. When
it is filed in a Series, that Series's Co-authors also see its title and
status among the Series' Books, so they can order them — never its contents.

**In progress**:
The Book status of a Published Book whose Chapters are still coming out.
_Avoid_: Ongoing

**Complete**:
The Book status of a Published Book declared finished. A label for readers
only: Chapters may still be added, and the Book may return to In progress.
_Avoid_: Finished, full text

**Chapter**:
One instalment of a Book, and the unit a reader reads. It belongs to exactly
one Book and never stands alone.
_Avoid_: Part, section, episode

**Reading order**:
The explicit position of each Chapter within its Book, independent of when a
Chapter was created or published.
A reader sees a Chapter numbered by its place among the Book's Published
chapters, so the number is derived, not kept, and can change when a Chapter is
published, withdrawn or moved.
_Avoid_: Chapter number (a title may carry one; the order does not depend on it)

**Publication time**:
The moment a Chapter becomes Published. A Draft chapter has none.

**Draft chapter**:
A Chapter with no Publication time; only its Book's Co-authors and Moderators
can see it.

**Scheduled chapter**:
A Chapter whose Publication time is still in the future. Until then it is
hidden from readers entirely, not announced.

**Published**:
A Book whose status is In progress or Complete, or a Chapter whose Publication
time has passed. A reader sees a Chapter only when both it and its Book are
Published.
_Avoid_: Live, released

**Series**:
An optional grouping of Books, credited to one or more Co-authors; a Book may
stand alone with no Series.
_Avoid_: Collection

**Series order**:
The explicit position of each Book within its Series, independent of when a
Book was created or filed into it.

**Genre**:
A category of the catalogue, from a list Admins and Superadmins keep. A Book
has at most one. A Series may carry its own, set independently of its Books':
a Book never takes its Genre from its Series. Genres form exactly two levels:
a top-level Genre and the Subgenres beneath it. A Genre's name is unique
among its siblings only, so a Genre is told apart by its path ("Fantasy /
Urban"). Searching by a top-level Genre also finds its Subgenres' Books.
_Avoid_: Category, Tag (for a Genre)

**Subgenre**:
A Genre that sits beneath one top-level Genre. A Subgenre has no Subgenres of
its own. A top-level Genre cannot be deleted while it has Subgenres.
_Avoid_: Child genre, sub-category

**Tag**:
A free-form label a Work's Co-authors attach to it, any number of
them and from no list.
_Avoid_: Genre (for a Tag), keyword

**Unsaved text**:
What an Account has typed into a new or an existing Comment or Chapter but not
yet sent. It exists only on the Account's device, one per place it was typed (a
Book's Comment, a reply to one Comment, an edit of one Comment, one Chapter).
It is not a Draft book or a Draft chapter.

- It survives a reload and the loss of a session. It is discarded once sent,
  when its Account signs out, or when another Account signs in on that device.
- Text left exactly as it is saved in its place is not Unsaved text: opening an
  edit and changing nothing, or changing it back, leaves nothing behind.
- If its place is gone (the Chapter or Book deleted, the Comment made a
  Tombstone, the Account no longer a Co-author), the Account is offered a copy
  before it is discarded.
- Unsaved text on a Chapter remembers the version it was typed against: when a
  Co-author has saved since, the Account chooses between that Co-author's
  version and its own, and nothing is overwritten silently.

_Avoid_: Draft (for text not yet sent)

**Device preferences**:
How the app looks and reads on one device, such as its theme, the layout of
Book lists (grid or list), or how a Chapter reads: its background, font,
font size, line height, text width and Reading layout. The server never sees
them, so another device does not share them,
and signing out keeps them.
_Avoid_: Settings, Profile (both suggest something the Account keeps)

**Reading layout**:
How a Chapter's text is laid out for reading, a Device preference: **Scroll**
(one continuous column) or **Pages** (screen-sized pages turned sideways, two
side by side like an open book when the screen is wide enough).
_Avoid_: Book mode, Reader mode (a Book is the work, not a way of reading it)

### Comments

**Comment**:
A remark an Account (its Owner) posts on a Book, optionally in reply to
another Comment.
_Avoid_: Post, message

**Tombstone**:
A Deleted or Removed comment. It stays in its thread so its replies keep their
place, and shows neither its text nor its Owner.
_Avoid_: Deleted placeholder

**Deleted comment**:
A Tombstone its Owner made by deleting the comment, or one left behind when the
Owner's Account was deleted. Nobody can restore it.
_Avoid_: Removed comment (that one a Moderator made)

**Removed comment**:
A Tombstone a Moderator made. A Moderator can restore it; nobody can edit it.
_Avoid_: Deleted comment (that one its Owner made)

**Report**:
An Account's flag on someone else's Comment for Moderators to look at, with a
reason: Spam, Harassment, Spoilers, or Other with a required explanation. An
Account reports a Comment at most once and cannot withdraw it; a Tombstone
cannot be reported. Its reporter is never told the outcome.
_Avoid_: Complaint, flag (as a noun), abuse report

**Report status**:
Where a Report stands: **New** (no Moderator has taken it), **In review** (a
Moderator has taken it), **Upheld** (its Comment became a Removed comment) or
**Dismissed**. A Moderator acts on every Open report of a Comment at once, and
a settled Report is kept with its outcome.
_Avoid_: Banned, Not banned (Banning is about Accounts, not Reports)

**Open report**:
A New or In review Report. While a Comment has one, everyone sees it marked as
under review and nobody can report it again. When a Dismissed Comment's text is
later changed beyond small corrections, a New Report is opened on it again.

**System report**:
The New Report the platform itself opens when a Dismissed Comment's text is
changed beyond small corrections. It has no reporter and repeats the reason of
the Dismissed Report it follows.
_Avoid_: Auto report, bot report

**Ban mark**:
The flag Moderators see on an Account that owns 10 or more Comments with at
least one Upheld Report each; a restored Comment still counts. It only suggests
blocking the Account: a Moderator decides.
_Avoid_: Strike, automatic ban

### Notifications

**Notification**:
An in-app notice to one Account. It tells a Co-author that someone else changed
who is credited on a shared Work, or deleted it; or it tells an
Account that something it holds as a Favorite has a New chapter or a New book.
It keeps the Work's title and the actor's name as they were at the time, so it
outlives both. New chapters of one Book gather into one unread Notification
until the Account reads it. Opening the Notification list reads every unread
one at once; a minute after it is read, a Notification is deleted for good.
_Avoid_: Notice, alert, message, push

**New chapter**:
A Chapter of a Published Book whose Publication time has just passed. It is
announced to the Accounts that hold that Book as a Favorite, except the Book's
Co-authors.

**New book**:
A Book in a Series whose Release time has just passed. It is announced to the
Accounts that hold that Series as a Favorite, except the Book's Co-authors.
_Avoid_: New release (that is a Sort order)

**Online**:
An Account that has the app open on at least one device at the moment of an
event. An Online Account is shown a New chapter or New book at once; one that
is not Online is sent an email as well. Either way the Notification is kept
until it is read.

### Favorites

**Favorite**:
A Work an Account marks to follow it: it keeps the Work on the
Account's list and brings Notifications of its New chapters (for a Book) or New
books (for a Series). Private to the Account; it is not approval and does not
count toward Popularity. A Favorite on a Book that is no longer Published is
kept but not shown or counted until the Book is Published again.
_Avoid_: Follow, subscription, bookmark, Like (for a Favorite)

### Likes

**Like**:
An Account's vote of approval on exactly one Book or one Comment, never both
at once.
_Avoid_: Vote, favorite, upvote

**Popularity**:
How many Likes a Book has received, all time. Dislikes and Likes on its
Comments do not count. A Series is not Liked itself: its Popularity is the sum
of its Published Books'.
_Avoid_: Rating, trending

### Library and Reading lists

**Library**:
The Books an Account keeps track of, each with one Reading status. Private to
the Account; a Book shows only how many Libraries hold it in each status. It is
separate from Favorites: it brings no Notifications.
_Avoid_: Favorites, bookshelf

**Reading status**:
Where an Account stands with a Book in its Library: **Reading**, **Plan to
read**, **Read** or **Not interested**. A Book with any status but Not
interested counts as in that Account's Library.

- Add sets Plan to read on a Book with no status or Not interested; any other
  status stays. Remove clears the status.
- Opening a Chapter sets Reading on a Book with no status, Plan to read or Not
  interested. Reaching the end of the last Published Chapter of a Complete Book
  sets Read. Read is never lowered, and a Book returning to In progress does
  not undo it.
- Not interested can be set only on a Book with no status or Plan to read. It
  hides the Book from that Account's search results and the Main page sections,
  nowhere else.
- A Co-author has no Reading status on its own Work, and cannot Favorite it.
- A Series has no status of its own: acting on it acts on its Published Books
  as above. It counts as in the Library when any of those Books is.

_Avoid_: Shelf

**Reading list**:
A named list of Published Books and Series an Account puts together, with a
Description and Tags. Anyone may read one; only an Account may make one. A Book
or Series that stops being Published stays on it but is not shown or counted
until it is Published again. An Account holds at most 50 Reading lists and a
list at most 100 items, hidden ones counted. Copying someone's Reading list
makes an independent list of one's own, with no tie back to the original.
_Avoid_: Collection (that is not a Series either), selection, shelf

**Recently viewed**:
The last six Books whose page or Chapter was opened on one device. Like a
Device preference, the server keeps no copy of it. A Guest's views carry over to the
Account that signs in; it is cleared only when a different Account from the
last one signs in on that device. On first load, Books the Account can no
longer see are dropped from it.

### Discovery

**Release time**:
The Publication time of a Book's earliest Published Chapter: the moment it
first had something to read. A Book with no Published Chapter has none, so it
is listed after every New release. Its Book status and creation time do not enter into it.
_Avoid_: Created at, publish date (for a Book)

**New release**:
A Book ranked by its Release time, latest first.
_Avoid_: New book (for any recently created Book)

**Last update**:
The Publication time of a Book's latest Published Chapter. Editing a Book's
details or an existing Chapter does not move it, and neither does a Scheduled
chapter until its Publication time passes.
_Avoid_: Updated at (for a Book)

**Search filter**:
A condition that narrows which Books a search finds, such as its text, a
Co-author (any Co-author's login or name), a Series, a Genre, a Book status, or
a range of Release times or Last updates. The query parameter stays `author=`.
A search's Search filters all apply at once.
_Avoid_: Sort (for a condition that narrows)

**Sort order**:
The order a search's Books are listed in: by Popularity, as New releases, or
by Last update. It never changes which Books are found, only their order, so
it is not a Search filter.
_Avoid_: Filter, ranking
