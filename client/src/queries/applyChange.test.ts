import { createTestQueryClient } from '@/test/queryClient';
import { applyChange, type Change } from './applyChange';

const KEYS = [
  ['books', {}],
  ['books', 7],
  ['books', 8],
  ['books', 0],
  ['books', 1],
  ['series', {}],
  ['series', 7],
  ['series', 8],
  ['genres'],
  ['readingLists', {}],
  ['readingLists', 7],
  ['readingLists', 8],
  ['myReadingLists', {}],
  ['chapters', { bookId: 2 }],
  ['chapters', 5],
  ['chapters', 6],
  ['books', 2],
  ['library', {}],
  ['favorites', {}],
  ['auth', 'me'],
  ['comments', { bookId: 1 }],
  ['authors', { q: 'a' }],
  ['accounts', 3],
  ['notifications', 1],
] as const;

const staleAfter = async (change: Change) => {
  const client = createTestQueryClient();
  KEYS.forEach((key) => client.setQueryData(key, 'x'));
  await applyChange(client, change);
  return KEYS.filter((key) => client.getQueryState(key)?.isInvalidated).map(
    (key) => JSON.stringify(key)
  );
};
// The serialized form `staleAfter` returns, for one key or several.
const j = (key: unknown) => JSON.stringify(key);
const s = (...keys: unknown[]) => keys.map(j);

describe('applyChange', () => {
  it('bookChanged refreshes books, series and genres only', async () => {
    const stale = await staleAfter({ type: 'bookChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(
        s(
          ['books', {}],
          ['books', 7],
          ['books', 2],
          ['series', {}],
          ['series', 7],
          ['genres']
        )
      )
    );
    expect(stale).not.toContain(j(['readingLists', 7]));
    expect(stale).not.toContain(j(['chapters', 5]));
    expect(stale).not.toContain(j(['library', {}]));
    expect(stale).not.toContain(j(['favorites', {}]));
  });

  it('bookDeleted skips the deleted detail', async () => {
    const stale = await staleAfter({ type: 'bookDeleted', id: 7 });
    expect(stale).toEqual(
      expect.arrayContaining(
        s(['books', {}], ['books', 8], ['series', {}], ['genres'])
      )
    );
    expect(stale).not.toContain(j(['books', 7]));
  });

  it('bookDeleted with id 0 skips only books/0', async () => {
    const stale = await staleAfter({ type: 'bookDeleted', id: 0 });
    expect(stale).not.toContain(j(['books', 0]));
    expect(stale).toContain(j(['books', 1]));
  });

  it('bookDeleteFailed refreshes the detail too', async () => {
    const stale = await staleAfter({ type: 'bookDeleteFailed' });
    expect(stale).toEqual(expect.arrayContaining(s(['books', 7], ['genres'])));
  });

  it('seriesChanged refreshes series and books, not genres', async () => {
    const stale = await staleAfter({ type: 'seriesChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['series', 7], ['books', 7]))
    );
    expect(stale).not.toContain(j(['genres']));
  });

  it('seriesDeleted skips the deleted detail', async () => {
    const stale = await staleAfter({ type: 'seriesDeleted', id: 7 });
    expect(stale).not.toContain(j(['series', 7]));
    expect(stale).toEqual(
      expect.arrayContaining(s(['series', 8], ['books', 7]))
    );
  });

  it('seriesDeleteFailed refreshes the detail', async () => {
    const stale = await staleAfter({ type: 'seriesDeleteFailed' });
    expect(stale).toContain(j(['series', 7]));
  });

  it('readingListChanged refreshes lists and my lists', async () => {
    const stale = await staleAfter({ type: 'readingListChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['readingLists', 7], ['myReadingLists', {}]))
    );
    expect(stale).not.toContain(j(['books', 7]));
  });

  it('readingListDeleted skips the deleted detail', async () => {
    const stale = await staleAfter({ type: 'readingListDeleted', id: 7 });
    expect(stale).not.toContain(j(['readingLists', 7]));
    expect(stale).toEqual(
      expect.arrayContaining(s(['readingLists', 8], ['myReadingLists', {}]))
    );
  });

  it('readingListDeleteFailed refreshes the detail', async () => {
    const stale = await staleAfter({ type: 'readingListDeleteFailed' });
    expect(stale).toContain(j(['readingLists', 7]));
  });

  it('chapterChanged refreshes chapters and that book only', async () => {
    const stale = await staleAfter({ type: 'chapterChanged', bookId: 2 });
    expect(stale).toEqual(
      expect.arrayContaining(
        s(['chapters', { bookId: 2 }], ['chapters', 5], ['books', 2])
      )
    );
    expect(stale).not.toContain(j(['books', 7]));
    expect(stale).not.toContain(j(['books', {}]));
  });

  it('chapterDeleted skips the deleted chapter detail', async () => {
    const stale = await staleAfter({
      type: 'chapterDeleted',
      bookId: 2,
      id: 5,
    });
    expect(stale).not.toContain(j(['chapters', 5]));
    expect(stale).toEqual(
      expect.arrayContaining(
        s(['chapters', 6], ['chapters', { bookId: 2 }], ['books', 2])
      )
    );
  });

  it('bookLibraryChanged refreshes books and library only', async () => {
    const stale = await staleAfter({ type: 'bookLibraryChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['books', 7], ['library', {}]))
    );
    expect(stale).not.toContain(j(['series', {}]));
    expect(stale).not.toContain(j(['favorites', {}]));
  });

  it('seriesLibraryChanged refreshes that series detail, books and library', async () => {
    const stale = await staleAfter({ type: 'seriesLibraryChanged', id: 7 });
    expect(stale).toEqual(
      expect.arrayContaining(s(['series', 7], ['books', {}], ['library', {}]))
    );
    expect(stale).not.toContain(j(['series', 8]));
    expect(stale).not.toContain(j(['genres']));
  });

  it('readingProgressRecorded refreshes books, series and library', async () => {
    const stale = await staleAfter({ type: 'readingProgressRecorded' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['books', 7], ['series', 8], ['library', {}]))
    );
    expect(stale).not.toContain(j(['favorites', {}]));
  });

  it('favoriteToggled refreshes the given detail and favorites', async () => {
    const stale = await staleAfter({
      type: 'favoriteToggled',
      detailKey: ['books', 7],
    });
    expect(stale).toEqual(
      expect.arrayContaining(s(['books', 7], ['favorites', {}]))
    );
    expect(stale).not.toContain(j(['books', 8]));
    expect(stale).not.toContain(j(['series', 7]));
  });

  it('favoriteToggled with a series detail key refreshes that series', async () => {
    const stale = await staleAfter({
      type: 'favoriteToggled',
      detailKey: ['series', 7],
    });
    expect(stale).toContain(j(['series', 7]));
    expect(stale).not.toContain(j(['series', 8]));
  });

  it('favoriteRemoved refreshes favorites, books and series', async () => {
    const stale = await staleAfter({ type: 'favoriteRemoved' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['favorites', {}], ['books', 8], ['series', 8]))
    );
    expect(stale).not.toContain(j(['library', {}]));
  });

  it('accountChanged refreshes every place an Account is embedded', async () => {
    const stale = await staleAfter({ type: 'accountChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(
        s(
          ['auth', 'me'],
          ['books', 7],
          ['series', 7],
          ['comments', { bookId: 1 }],
          ['authors', { q: 'a' }],
          ['accounts', 3]
        )
      )
    );
    expect(stale).not.toContain(j(['notifications', 1]));
    expect(stale).not.toContain(j(['genres']));
    expect(stale).not.toContain(j(['library', {}]));
  });

  it('genreChanged refreshes genres, books and series', async () => {
    const stale = await staleAfter({ type: 'genreChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['genres'], ['books', 7], ['series', 7]))
    );
    expect(stale).not.toContain(j(['comments', { bookId: 1 }]));
    expect(stale).not.toContain(j(['auth', 'me']));
  });

  it.each([0, 7, 2_147_483_647])(
    'never touches favorites or library (id %i)',
    async (id) => {
      const changes: Change[] = [
        { type: 'bookChanged' },
        { type: 'bookDeleteFailed' },
        { type: 'bookDeleted', id },
        { type: 'seriesChanged' },
        { type: 'seriesDeleteFailed' },
        { type: 'seriesDeleted', id },
        { type: 'readingListChanged' },
        { type: 'readingListDeleteFailed' },
        { type: 'readingListDeleted', id },
        { type: 'chapterChanged', bookId: id },
        { type: 'chapterDeleted', bookId: id, id },
      ];
      for (const change of changes) {
        const stale = await staleAfter(change);
        expect(stale).not.toContain(j(['favorites', {}]));
        expect(stale).not.toContain(j(['library', {}]));
      }
    }
  );

  // Favorites is invalidated whatever detailKey says, so a bare "something went
  // stale" check would pass if detailKey were ignored; name the detail itself.
  it.each([0, 7])(
    'favoriteToggled invalidates the detail named by detailKey (id %i)',
    async (id) => {
      const stale = await staleAfter({
        type: 'favoriteToggled',
        detailKey: ['books', id],
      });
      expect(stale).toContain(j(['books', id]));
    }
  );

  it('seriesLibraryChanged invalidates the detail named by id', async () => {
    const stale = await staleAfter({ type: 'seriesLibraryChanged', id: 8 });
    expect(stale).toContain(j(['series', 8]));
    expect(stale).not.toContain(j(['series', 7]));
  });
});
