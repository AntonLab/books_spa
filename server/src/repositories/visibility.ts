import type { Request } from 'express';
import { literal, Op, type IncludeOptions, type WhereOptions } from 'sequelize';
import { Book } from '../models/Book.ts';
import { BookAuthor } from '../models/BookAuthor.ts';
import { SeriesAuthor } from '../models/SeriesAuthor.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../types/errors.ts';
import { isModeratorRole } from 'shared';
import type { Role } from '../types/permission.ts';

// Who is reading, as far as Draft books are concerned: the signed-in account's
// id and Role, or null for a Guest. Passed to every repository read that can
// reach a book, so the rule lives in the query rather than in each controller.
export type Viewer = { id: number; role: Role } | null;

export type Account = NonNullable<Viewer>;

// The account behind a write, for the notifications it raises. Every route
// that calls this is guarded, so an unset req.user here is a wiring mistake
// and is refused as one.
export function actorOf(req: Request): { id: number; role: Role } {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, role: req.user.role };
}

// A Moderator reads every Draft book, but only by direct link: no list is
// widened for one.
function isModerator(viewer: Viewer): boolean {
  return isModeratorRole(viewer?.role);
}

// Listed is narrower than readable: a Draft book shows in exactly one list,
// its own Co-author's `?userId=`, which is where "My books" finds it. Every
// other list — a Moderator's included — leaves it out. null when the list may
// hold drafts; readableBookWhere still decides which.
export function listedBookWhere(
  viewer: Viewer,
  userId: number | undefined
): WhereOptions | null {
  const listingOwnBooks =
    viewer !== null && userId !== undefined && userId === viewer.id;
  return listingOwnBooks ? null : { status: { [Op.ne]: 'draft' } };
}

// The books a viewer may read, as a WHERE on `books`: every Published book,
// plus the Draft books the viewer co-authors — or every book at all for a
// Moderator. The one definition every read that can reach a book goes through:
// a book's own detail, and the chapters, comments and likes hanging off it.
export async function readableBookWhere(viewer: Viewer): Promise<WhereOptions> {
  if (isModerator(viewer)) return {};
  return readableBookWhereFor(await creditedBookIds(viewer));
}

// The single-book form of readableBookWhere.
async function canReadBook(bookId: number, viewer: Viewer): Promise<boolean> {
  const book = await Book.findOne({
    where: { [Op.and]: [{ id: bookId }, await readableBookWhere(viewer)] },
    attributes: ['id'],
  });
  return book !== null;
}

// Refuses an action on a Draft book. A viewer who may not read the draft gets
// the not-found answer a missing book gets, so its existence stays hidden; one
// who may (a Co-author, a Moderator) is told plainly with a 403.
export async function assertDraftRefusal(
  bookId: number,
  actor: Account,
  notFound: NotFoundError,
  forbiddenMessage: string
): Promise<never> {
  if (!(await canReadBook(bookId, actor))) throw notFound;
  throw new ForbiddenError(forbiddenMessage);
}

// Split from readableBookWhere so readableChapterScope, which needs the
// credited ids twice, looks them up once.
function readableBookWhereFor(credited: number[]): WhereOptions {
  const published: WhereOptions = { status: { [Op.ne]: 'draft' } };
  return credited.length === 0
    ? published
    : { [Op.or]: [published, { id: credited }] };
}

// An inner join on a row's `book` association, carrying no columns of its own:
// it only drops the rows — chapters, comments — that hang off a Draft book the
// viewer may not read.
export async function readableBookInclude(
  viewer: Viewer
): Promise<IncludeOptions> {
  return bookIncludeWhere(await readableBookWhere(viewer));
}

function bookIncludeWhere(where: WhereOptions): IncludeOptions {
  return { model: Book, as: 'book', attributes: [], required: true, where };
}

// The Draft books a viewer may not read, as a parenthesised SQL subquery on
// `books` for `literal` or nesting; null for a Moderator. For reads that cannot
// join one `book` (a like points at a book or a comment on one). A subquery,
// not an id list, because drafts grow with the catalogue. Only credited book
// ids from creditedBookIds are interpolated; they are integers.
export async function hiddenBooksSubquery(
  viewer: Viewer
): Promise<string | null> {
  if (isModerator(viewer)) return null;

  const credited = await creditedBookIds(viewer);
  const notCredited =
    credited.length > 0 ? ` AND \`id\` NOT IN (${credited.join(',')})` : '';
  return `(SELECT \`id\` FROM \`${Book.tableName}\` WHERE \`status\` = 'draft'${notCredited})`;
}

// Every series holding at least one Published book, for any viewer. A series
// has no status of its own; an empty or all-draft one simply has nothing a
// reader could open yet.
//
// A subquery rather than an id list, because it grows with the whole
// catalogue. It carries no caller-supplied value, so there is nothing to bind.
export function publishedSeriesWhere(): WhereOptions {
  return {
    id: {
      [Op.in]: literal(
        "(SELECT DISTINCT `seriesId` FROM `books` WHERE `status` <> 'draft' AND `seriesId` IS NOT NULL)"
      ),
    },
  };
}

// The series a viewer may see, as a WHERE on `series`: the published ones,
// plus the series the viewer co-authors — or every series for a Moderator.
export async function visibleSeriesWhere(
  viewer: Viewer
): Promise<WhereOptions> {
  if (isModerator(viewer)) return {};

  const withPublishedBook = publishedSeriesWhere();
  if (viewer === null) return withPublishedBook;

  const credited = await SeriesAuthor.findAll({
    where: { userId: viewer.id },
    attributes: ['seriesId'],
  });
  if (credited.length === 0) return withPublishedBook;

  return {
    [Op.or]: [
      withPublishedBook,
      { id: credited.map((credit) => credit.seriesId) },
    ],
  };
}

// The viewer a request reads as. requirePermission sets req.user whenever a
// session resolves, public reads included, so an unset one really is a Guest.
export function viewerOf(user: { id: number; role: Role } | undefined): Viewer {
  return user ? { id: user.id, role: user.role } : null;
}

// The chapters a viewer may read, as a WHERE on `chapters` and an inner join on
// the chapter's book. A reader needs both halves: a Published book, and a
// Publication time that has passed. A Co-author of the book reads every chapter
// in it — drafts and scheduled ones are theirs to work on — and a Moderator
// reads everything.
//
// "Now" is this process's clock, the same one that stamps `publishedAt: 'now'`,
// so a chapter published immediately is readable on the very next request and
// a scheduled one comes out without anything having to flip it.
export async function readableChapterScope(
  viewer: Viewer
): Promise<{ where: WhereOptions; include: IncludeOptions }> {
  if (isModerator(viewer)) {
    return { where: {}, include: bookIncludeWhere({}) };
  }

  const credited = await creditedBookIds(viewer);
  const include = bookIncludeWhere(readableBookWhereFor(credited));
  const published: WhereOptions = { publishedAt: { [Op.lte]: new Date() } };
  if (credited.length === 0) return { where: published, include };

  return {
    where: { [Op.or]: [published, { bookId: credited }] },
    include,
  };
}

async function creditedBookIds(viewer: Viewer): Promise<number[]> {
  if (viewer === null) return [];
  const credits = await BookAuthor.findAll({
    where: { userId: viewer.id },
    attributes: ['bookId'],
  });
  return credits.map((credit) => credit.bookId);
}
