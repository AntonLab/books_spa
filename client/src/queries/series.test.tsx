import { act, waitFor } from '@testing-library/react';
import { ApiError } from '../api/client';
import {
  useAddBookToSeries,
  useCreateSeries,
  useDeleteSeries,
  useDeleteSeriesCover,
  useFavoritedSeries,
  useRemoveBookFromSeries,
  useReorderSeriesBooks,
  useSeriesList,
  useUpdateSeries,
  useUploadSeriesCover,
} from './series';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';
import { publicBook, publicSeries } from '../test/works';
import { renderHookWithProviders } from '../test/renderWithProviders';
import * as booksApi from '../api/books';
import * as seriesApi from '../api/series';
import type { SeriesPayload } from 'shared';

jest.mock('../api/series');
jest.mock('../api/books');
jest.mock('./applyChange', () => ({ applyChange: jest.fn() }));
const mockedSeries = jest.mocked(seriesApi);
const mockedBooks = jest.mocked(booksApi);
const mockedApplyChange = jest.mocked(applyChange);

const body = { items: [], total: 0, limit: 20, offset: 0 };

beforeEach(() => {
  jest.resetAllMocks();
  mockedApplyChange.mockResolvedValue(undefined);
});

describe('useSeriesList', () => {
  it('asks for the params it is given, and nothing while disabled', async () => {
    mockedSeries.listSeries.mockResolvedValue(body);
    renderHookWithProviders(() => useSeriesList({ limit: 5 }, false));
    const { result } = renderHookWithProviders(() =>
      useSeriesList({ userId: 3, limit: 20 }, true)
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSeries.listSeries).toHaveBeenCalledTimes(1);
    expect(mockedSeries.listSeries).toHaveBeenCalledWith({
      userId: 3,
      limit: 20,
    });
  });
});

describe('useCreateSeries', () => {
  it('reports a series change', async () => {
    mockedSeries.createSeries.mockResolvedValue(publicSeries());
    const { result, queryClient } = renderHookWithProviders(() =>
      useCreateSeries()
    );

    result.current.mutate({ title: 'S' } as SeriesPayload);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesChanged',
    });
  });
});

describe('useUpdateSeries', () => {
  it('reports a series change', async () => {
    mockedSeries.updateSeries.mockResolvedValue(publicSeries());
    const { result, queryClient } = renderHookWithProviders(() =>
      useUpdateSeries(12)
    );

    result.current.mutate({ title: 'S' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesChanged',
    });
  });

  it('refreshes nothing after a failed update', async () => {
    mockedSeries.updateSeries.mockRejectedValue(new ApiError(409, 'conflict'));
    const { result } = renderHookWithProviders(() => useUpdateSeries(12));

    result.current.mutate({ title: 'S' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApplyChange).not.toHaveBeenCalled();
  });
});

describe('useDeleteSeries', () => {
  it('reports the deleted series', async () => {
    mockedSeries.deleteSeries.mockResolvedValue(undefined);
    const { result, queryClient } = renderHookWithProviders(() =>
      useDeleteSeries(12)
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesDeleted',
      id: 12,
    });
  });

  it('reports the deleted series when its id is 0', async () => {
    mockedSeries.deleteSeries.mockResolvedValue(undefined);
    const { result, queryClient } = renderHookWithProviders(() =>
      useDeleteSeries(0)
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesDeleted',
      id: 0,
    });
  });

  it('reports a failed delete too', async () => {
    mockedSeries.deleteSeries.mockRejectedValue(new ApiError(404, 'gone'));
    const { result, queryClient } = renderHookWithProviders(() =>
      useDeleteSeries(12)
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesDeleteFailed',
    });
  });
});

describe('useAddBookToSeries / useRemoveBookFromSeries', () => {
  it('reports a series change after adding a book', async () => {
    mockedBooks.updateBook.mockResolvedValue(publicBook());
    const { result, queryClient } = renderHookWithProviders(() =>
      useAddBookToSeries(12)
    );

    result.current.mutate(3);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedBooks.updateBook).toHaveBeenCalledWith(3, { seriesId: 12 });
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesChanged',
    });
  });

  it('reports a series change after removing a book', async () => {
    mockedSeries.removeBookFromSeries.mockResolvedValue(undefined);
    const { result, queryClient } = renderHookWithProviders(() =>
      useRemoveBookFromSeries(12)
    );

    result.current.mutate(3);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSeries.removeBookFromSeries).toHaveBeenCalledWith(12, 3);
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesChanged',
    });
  });
});

describe('useReorderSeriesBooks', () => {
  it.each([
    [
      'saves',
      () => mockedSeries.reorderSeriesBooks.mockResolvedValue(undefined),
    ],
    [
      'is refused with a 409',
      () =>
        mockedSeries.reorderSeriesBooks.mockRejectedValue(
          new ApiError(
            409,
            'The books of this series changed since you loaded them'
          )
        ),
    ],
  ])(
    'reports the series books and the Series page grid as reordered after a reorder that %s',
    async (_label, arrange) => {
      arrange();
      const { result, queryClient } = renderHookWithProviders(() =>
        useReorderSeriesBooks(3)
      );

      await act(() =>
        result.current.mutateAsync([2, 1]).catch(() => undefined)
      );

      expect(mockedApplyChange).toHaveBeenCalledTimes(1);
      expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
        type: 'listReordered',
        keys: [queryKeys.seriesBooks(3), queryKeys.allBooks],
      });
    }
  );

  it('puts the old order back in the cache when the save fails for any reason but a 409', async () => {
    mockedSeries.reorderSeriesBooks.mockRejectedValue(
      new ApiError(500, 'Internal Server Error')
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useReorderSeriesBooks(3)
    );
    const rows = [{ id: 1 }, { id: 2 }];
    queryClient.setQueryData(queryKeys.seriesBooks(3), { items: rows });

    await act(() => result.current.mutateAsync([2, 1]).catch(() => undefined));

    expect(queryClient.getQueryData(queryKeys.seriesBooks(3))).toEqual({
      items: rows,
    });
  });
});

describe('useFavoritedSeries', () => {
  it('asks the favorited list, cached under favoritedBy', async () => {
    mockedSeries.listFavoritedSeries.mockResolvedValue(body);

    const { result, queryClient } = renderHookWithProviders(() =>
      useFavoritedSeries({ tag: 'a' }, true)
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSeries.listFavoritedSeries).toHaveBeenCalledWith({ tag: 'a' });
    expect(queryClient.getQueryData(['series', { tag: 'a' }])).toBeUndefined();
    expect(
      queryClient.getQueryData(['series', { tag: 'a', favoritedBy: 'me' }])
    ).toEqual(body);
  });
});

describe('useUploadSeriesCover / useDeleteSeriesCover', () => {
  it('upload calls the API and reports a series change', async () => {
    mockedSeries.uploadSeriesCover.mockResolvedValue(publicSeries());
    const { result, queryClient } = renderHookWithProviders(() =>
      useUploadSeriesCover(12)
    );
    const file = new File([new Uint8Array([1])], 'a.webp', {
      type: 'image/webp',
    });

    result.current.mutate(file);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSeries.uploadSeriesCover).toHaveBeenCalledWith(12, file);
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesChanged',
    });
  });

  it('delete calls the API and reports a series change', async () => {
    mockedSeries.deleteSeriesCover.mockResolvedValue(undefined);
    const { result, queryClient } = renderHookWithProviders(() =>
      useDeleteSeriesCover(12)
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSeries.deleteSeriesCover).toHaveBeenCalledWith(12);
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'seriesChanged',
    });
  });
});
