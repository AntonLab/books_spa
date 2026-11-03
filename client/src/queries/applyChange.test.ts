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
const s = (...keys: unknown[]) => keys.map((k) => JSON.stringify(k));

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
    expect(stale).not.toContain(s(['readingLists', 7])[0]);
    expect(stale).not.toContain(s(['chapters', 5])[0]);
    expect(stale).not.toContain(s(['library', {}])[0]);
    expect(stale).not.toContain(s(['favorites', {}])[0]);
  });

  it('bookDeleted skips the deleted detail', async () => {
    const stale = await staleAfter({ type: 'bookDeleted', id: 7 });
    expect(stale).toEqual(
      expect.arrayContaining(
        s(['books', {}], ['books', 8], ['series', {}], ['genres'])
      )
    );
    expect(stale).not.toContain(s(['books', 7])[0]);
  });

  it('bookDeleted with id 0 skips only books/0', async () => {
    const stale = await staleAfter({ type: 'bookDeleted', id: 0 });
    expect(stale).not.toContain(s(['books', 0])[0]);
    expect(stale).toContain(s(['books', 1])[0]);
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
    expect(stale).not.toContain(s(['genres'])[0]);
  });

  it('seriesDeleted skips the deleted detail', async () => {
    const stale = await staleAfter({ type: 'seriesDeleted', id: 7 });
    expect(stale).not.toContain(s(['series', 7])[0]);
    expect(stale).toEqual(
      expect.arrayContaining(s(['series', 8], ['books', 7]))
    );
  });

  it('seriesDeleteFailed refreshes the detail', async () => {
    const stale = await staleAfter({ type: 'seriesDeleteFailed' });
    expect(stale).toContain(s(['series', 7])[0]);
  });

  it('readingListChanged refreshes lists and my lists', async () => {
    const stale = await staleAfter({ type: 'readingListChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['readingLists', 7], ['myReadingLists', {}]))
    );
    expect(stale).not.toContain(s(['books', 7])[0]);
  });

  it('readingListDeleted skips the deleted detail', async () => {
    const stale = await staleAfter({ type: 'readingListDeleted', id: 7 });
    expect(stale).not.toContain(s(['readingLists', 7])[0]);
    expect(stale).toEqual(
      expect.arrayContaining(s(['readingLists', 8], ['myReadingLists', {}]))
    );
  });

  it('readingListDeleteFailed refreshes the detail', async () => {
    const stale = await staleAfter({ type: 'readingListDeleteFailed' });
    expect(stale).toContain(s(['readingLists', 7])[0]);
  });

  it('chapterChanged refreshes chapters and that book only', async () => {
    const stale = await staleAfter({ type: 'chapterChanged', bookId: 2 });
    expect(stale).toEqual(
      expect.arrayContaining(
        s(['chapters', { bookId: 2 }], ['chapters', 5], ['books', 2])
      )
    );
    expect(stale).not.toContain(s(['books', 7])[0]);
    expect(stale).not.toContain(s(['books', {}])[0]);
  });

  it('chapterDeleted skips the deleted chapter detail', async () => {
    const stale = await staleAfter({
      type: 'chapterDeleted',
      bookId: 2,
      id: 5,
    });
    expect(stale).not.toContain(s(['chapters', 5])[0]);
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
    expect(stale).not.toContain(s(['series', {}])[0]);
    expect(stale).not.toContain(s(['favorites', {}])[0]);
  });

  it('seriesLibraryChanged refreshes that series detail, books and library', async () => {
    const stale = await staleAfter({ type: 'seriesLibraryChanged', id: 7 });
    expect(stale).toEqual(
      expect.arrayContaining(s(['series', 7], ['books', {}], ['library', {}]))
    );
    expect(stale).not.toContain(s(['series', 8])[0]);
    expect(stale).not.toContain(s(['genres'])[0]);
  });

  it('readingProgressRecorded refreshes books, series and library', async () => {
    const stale = await staleAfter({ type: 'readingProgressRecorded' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['books', 7], ['series', 8], ['library', {}]))
    );
    expect(stale).not.toContain(s(['favorites', {}])[0]);
  });

  it('favoriteToggled refreshes the given detail and favorites', async () => {
    const stale = await staleAfter({
      type: 'favoriteToggled',
      detailKey: ['books', 7],
    });
    expect(stale).toEqual(
      expect.arrayContaining(s(['books', 7], ['favorites', {}]))
    );
    expect(stale).not.toContain(s(['books', 8])[0]);
    expect(stale).not.toContain(s(['series', 7])[0]);
  });

  it('favoriteToggled with a series detail key refreshes that series', async () => {
    const stale = await staleAfter({
      type: 'favoriteToggled',
      detailKey: ['series', 7],
    });
    expect(stale).toContain(s(['series', 7])[0]);
    expect(stale).not.toContain(s(['series', 8])[0]);
  });

  it('favoriteRemoved refreshes favorites, books and series', async () => {
    const stale = await staleAfter({ type: 'favoriteRemoved' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['favorites', {}], ['books', 8], ['series', 8]))
    );
    expect(stale).not.toContain(s(['library', {}])[0]);
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
    expect(stale).not.toContain(s(['notifications', 1])[0]);
    expect(stale).not.toContain(s(['genres'])[0]);
    expect(stale).not.toContain(s(['library', {}])[0]);
  });

  it('genreChanged refreshes genres, books and series', async () => {
    const stale = await staleAfter({ type: 'genreChanged' });
    expect(stale).toEqual(
      expect.arrayContaining(s(['genres'], ['books', 7], ['series', 7]))
    );
    expect(stale).not.toContain(s(['comments', { bookId: 1 }])[0]);
    expect(stale).not.toContain(s(['auth', 'me'])[0]);
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
        expect(stale).not.toContain(s(['favorites', {}])[0]);
        expect(stale).not.toContain(s(['library', {}])[0]);
      }
    }
  );

  it.each([0, 7, 2_147_483_647])(
    'every new intent invalidates something (id %i)',
    async (id) => {
      const changes: Change[] = [
        { type: 'bookLibraryChanged' },
        { type: 'seriesLibraryChanged', id },
        { type: 'readingProgressRecorded' },
        { type: 'favoriteToggled', detailKey: ['books', id] },
        { type: 'favoriteRemoved' },
        { type: 'accountChanged' },
        { type: 'genreChanged' },
      ];
      for (const change of changes) {
        expect((await staleAfter(change)).length).toBeGreaterThan(0);
      }
    }
  );
});
