import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeriesOrderList } from './SeriesOrderList';
import { renderWithProviders } from '@/test/renderWithProviders';
import { layOutSortableRows, moveWithKeyboard } from '@/test/sortable';
import { ApiError } from '@/api/client';
import * as seriesApi from '@/api/series';
import * as booksApi from '@/api/books';
import { waitPastDebounce } from '@/test/waitPastDebounce';
import { sessionOf } from '@/test/session';
import type { PublicUser, SeriesBookSummary, SessionUser } from '@/types/api';
import type { PublicBook } from '@/types/book';

jest.mock('@/api/series');
jest.mock('@/api/books');

const mockedSeries = jest.mocked(seriesApi);
const mockedBooks = jest.mocked(booksApi);

const ann = {
  id: 3,
  login: 'ann',
  firstName: 'Ann',
  lastName: 'Author',
  status: 'active' as const,
  avatarUrl: null,
};
const cora = {
  id: 4,
  login: 'cora',
  firstName: 'Cora',
  lastName: 'Writer',
  status: 'active' as const,
  avatarUrl: null,
};

const sessionFor = (role: PublicUser['role']): SessionUser =>
  sessionOf({
    ...ann,
    email: 'ann@example.com',
    role,
    status: 'active',
    about: '',
    showLastSeen: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

const bookNamed = (
  id: number,
  title: string,
  status: SeriesBookSummary['status'] = 'complete',
  authors = [ann]
): SeriesBookSummary => ({ id, title, status, authors });

const listing = (items: SeriesBookSummary[]) => ({ items });

const renderList = (
  overrides: Partial<{
    mayEdit: boolean;
    session: SessionUser;
  }> = {}
) =>
  renderWithProviders(
    <SeriesOrderList
      seriesId={7}
      mayEdit
      session={sessionFor('author')}
      {...overrides}
    />
  );

const makeBooks = (n: number, seriesOf: (i: number) => number | null) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Book ${i + 1}`,
    seriesId: seriesOf(i),
  })) as unknown as PublicBook[];

const serveBooks = (books: PublicBook[]) =>
  mockedBooks.listBooks.mockImplementation(
    async ({ q, pageSize = 20 } = {}) => {
      const matches = q
        ? books.filter((book) => book.title.includes(q))
        : books;
      return {
        items: matches.slice(0, pageSize),
        total: matches.length,
        current: 1,
        pageSize,
      };
    }
  );

const ownBooks = makeBooks(101, () => null);

const serveOwnBooks = () => serveBooks(ownBooks);

beforeEach(() => {
  jest.resetAllMocks();
  mockedSeries.listSeriesBooks.mockResolvedValue(listing([]));
  mockedBooks.listBooks.mockResolvedValue({
    items: [],
    total: 0,
    current: 1,
    pageSize: 20,
  });
});

describe('SeriesOrderList', () => {
  it('lists each book with its status and its authors, linked to its page', async () => {
    mockedSeries.listSeriesBooks.mockResolvedValue(
      listing([bookNamed(1, 'A Tale of Dragons', 'complete', [ann, cora])])
    );
    renderList();

    expect(
      await screen.findByRole('link', { name: 'A Tale of Dragons' })
    ).toHaveAttribute('href', '/books/1');
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('Ann Author, Cora Writer')).toBeInTheDocument();
  });

  it('names rather than links a draft the viewer may not read', async () => {
    mockedSeries.listSeriesBooks.mockResolvedValue(
      listing([bookNamed(2, 'Someone Else’s Draft', 'draft', [cora])])
    );
    renderList();

    expect(await screen.findByText('Someone Else’s Draft')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Someone Else’s Draft' })
    ).toBeNull();
  });

  it('opens that same draft for a moderator', async () => {
    mockedSeries.listSeriesBooks.mockResolvedValue(
      listing([bookNamed(2, 'Someone Else’s Draft', 'draft', [cora])])
    );
    renderList({ session: { ...sessionFor('admin'), id: 99 } });

    expect(
      await screen.findByRole('link', { name: 'Someone Else’s Draft' })
    ).toHaveAttribute('href', '/books/2');
  });

  it('tells the user to add a book from the book’s Edit dialog when the series is empty', async () => {
    mockedSeries.listSeriesBooks.mockResolvedValue(listing([]));
    renderList();

    expect(
      await screen.findByText(
        "No books yet. Add a book to this series from the book's Edit dialog."
      )
    ).toBeInTheDocument();
  });

  it('asks for no books at all until the viewer is known to be allowed to edit', () => {
    renderList({ mayEdit: false });

    expect(mockedSeries.listSeriesBooks).not.toHaveBeenCalled();
  });

  it('offers the Add a book picker to an editor', async () => {
    renderList({ mayEdit: true });

    expect(
      await screen.findByRole('combobox', { name: 'Add a book' })
    ).toBeInTheDocument();
  });

  it('offers no Add a book picker to a viewer who may not edit', () => {
    renderList({ mayEdit: false });

    expect(screen.queryByRole('combobox', { name: 'Add a book' })).toBeNull();
    expect(mockedBooks.listBooks).not.toHaveBeenCalled();
  });

  it('reaches the 101st own book by searching its title', async () => {
    serveOwnBooks();
    mockedBooks.updateBook.mockResolvedValue({} as never);
    renderList();

    const picker = await screen.findByRole('combobox', { name: 'Add a book' });
    await userEvent.type(picker, 'Book 101');
    await waitPastDebounce();
    await userEvent.click(await screen.findByText('Book 101'));

    await waitFor(() =>
      expect(mockedBooks.updateBook).toHaveBeenCalledWith(101, { seriesId: 7 })
    );
    expect(mockedBooks.listBooks).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 3, q: 'Book 101', pageSize: 100 })
    );
  });

  it('asks for the unfiltered page when the search is blank', async () => {
    serveOwnBooks();
    renderList();

    const picker = await screen.findByRole('combobox', { name: 'Add a book' });
    await userEvent.type(picker, '   ');
    await waitPastDebounce();

    const calls = mockedBooks.listBooks.mock.calls.map(([params]) => params);
    expect(calls.every((params) => params?.q === undefined)).toBe(true);
  });

  it('cuts a search term at SEARCH_TEXT_MAX_LENGTH (200)', async () => {
    serveOwnBooks();
    renderList();

    const picker = await screen.findByRole('combobox', { name: 'Add a book' });
    await userEvent.type(picker, 'a'.repeat(201));
    await waitPastDebounce();

    const qs = mockedBooks.listBooks.mock.calls.map(([params]) => params?.q);
    expect(qs[qs.length - 1]).toHaveLength(200);
  });

  it('says so when no book matches, and keeps the picker enabled', async () => {
    serveOwnBooks();
    renderList();

    const picker = await screen.findByRole('combobox', { name: 'Add a book' });
    await userEvent.type(picker, 'zzz');
    await waitPastDebounce();

    expect(await screen.findByText('No books found')).toBeInTheDocument();
    expect(picker).toBeEnabled();
  });

  it('hints to type a title when the first page has no free book and nothing is typed', async () => {
    serveBooks(makeBooks(101, (i) => (i < 100 ? 9 : null)));
    renderList();

    const picker = await screen.findByRole('combobox', { name: 'Add a book' });
    await waitFor(() => expect(mockedBooks.listBooks).toHaveBeenCalled());
    await userEvent.click(picker);

    expect(
      await screen.findByText('Type a title to find a book')
    ).toBeInTheDocument();
    expect(screen.queryByText('No books found')).toBeNull();
  });

  it('disables the picker with "No books to add" when there are no candidates at all', async () => {
    renderList(); // default mock: empty page

    expect(await screen.findByText('No books to add')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add a book' })).toBeDisabled();
  });

  it('disables the picker when exactly 100 own books are all in series and none wait past the page', async () => {
    const books = makeBooks(100, () => 9);
    mockedBooks.listBooks.mockResolvedValue({
      items: books,
      total: 100,
      current: 1,
      pageSize: 100,
    });
    renderList();

    expect(await screen.findByText('No books to add')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add a book' })).toBeDisabled();
  });

  it('keeps the picker enabled when the first 100 own books are all in series and a free one follows', async () => {
    serveBooks(makeBooks(101, (i) => (i < 100 ? 9 : null)));
    mockedBooks.updateBook.mockResolvedValue({} as never);
    renderList();

    const picker = await screen.findByRole('combobox', { name: 'Add a book' });
    await waitFor(() =>
      expect(mockedBooks.listBooks).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 3, pageSize: 100 })
      )
    );
    expect(screen.queryByText('No books to add')).toBeNull();
    expect(picker).toBeEnabled();

    await userEvent.type(picker, 'Book 101');
    await waitPastDebounce();
    await userEvent.click(await screen.findByText('Book 101'));
    await waitFor(() =>
      expect(mockedBooks.updateBook).toHaveBeenCalledWith(101, { seriesId: 7 })
    );
  });

  it('takes a book out of the series only once that is confirmed', async () => {
    mockedSeries.listSeriesBooks.mockResolvedValue(
      listing([bookNamed(1, 'A Tale of Dragons')])
    );
    mockedSeries.removeBookFromSeries.mockResolvedValue(undefined);
    renderList();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove from series' })
    );
    expect(mockedSeries.removeBookFromSeries).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Take it out' }));

    await waitFor(() =>
      expect(mockedSeries.removeBookFromSeries).toHaveBeenCalledWith(7, 1)
    );
  });

  it('on a conflict says why the order changed', async () => {
    const restoreLayout = layOutSortableRows();
    try {
      mockedSeries.reorderSeriesBooks.mockRejectedValue(
        new ApiError(
          409,
          'The books of this series changed since you loaded them'
        )
      );
      mockedSeries.listSeriesBooks
        .mockResolvedValueOnce(
          listing([bookNamed(1, 'One'), bookNamed(2, 'Two')])
        )
        .mockResolvedValue(listing([bookNamed(1, 'One'), bookNamed(2, 'Two')]));
      renderList();

      await moveWithKeyboard(
        await screen.findByRole('button', { name: 'Reorder One' }),
        'ArrowDown'
      );

      expect(mockedSeries.reorderSeriesBooks).toHaveBeenCalledWith(7, [2, 1]);
      expect(
        await screen.findByText(
          'A co-author changed the books of this series while you were reordering them. This is their current order.'
        )
      ).toBeInTheDocument();
    } finally {
      restoreLayout();
    }
  });
});
