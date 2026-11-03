import { act } from '@testing-library/react';
import { useRemoveFavorite, useToggleFavorite } from './favorites';
import { queryKeys } from './keys';
import { renderHookWithProviders } from '../test/renderWithProviders';
import { ApiError } from '../api/client';
import * as favoritesApi from '../api/favorites';
import { applyChange } from './applyChange';

jest.mock('../api/favorites');
jest.mock('./applyChange', () => ({ applyChange: jest.fn() }));
const mockedFavorites = jest.mocked(favoritesApi);
const mockedApplyChange = jest.mocked(applyChange);

const favorite = {
  id: 5,
  userId: 9,
  bookId: 7,
  seriesId: null,
  createdAt: '2026-09-26T10:00:00.000Z',
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedApplyChange.mockResolvedValue(undefined);
});

describe('useToggleFavorite', () => {
  it('adds when the viewer holds no Favorite, and reports favoriteToggled with the work key', async () => {
    mockedFavorites.createFavorite.mockResolvedValue(favorite);
    const { result, queryClient } = renderHookWithProviders(() =>
      useToggleFavorite(queryKeys.book(7))
    );

    await act(() =>
      result.current.mutateAsync({ existingId: null, payload: { bookId: 7 } })
    );

    expect(mockedFavorites.createFavorite).toHaveBeenCalledWith({ bookId: 7 });
    expect(mockedFavorites.deleteFavorite).not.toHaveBeenCalled();
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'favoriteToggled',
      detailKey: ['books', 7],
    });
  });

  it('removes the Favorite the viewer holds, and reports favoriteToggled', async () => {
    mockedFavorites.deleteFavorite.mockResolvedValue(undefined);
    const { result, queryClient } = renderHookWithProviders(() =>
      useToggleFavorite(queryKeys.seriesDetail(12))
    );

    await act(() =>
      result.current.mutateAsync({ existingId: 5, payload: { seriesId: 12 } })
    );

    expect(mockedFavorites.deleteFavorite).toHaveBeenCalledWith(5);
    expect(mockedFavorites.createFavorite).not.toHaveBeenCalled();
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'favoriteToggled',
      detailKey: queryKeys.seriesDetail(12),
    });
  });

  it('reports favoriteToggled after a refusal too, since a 409 means the page is stale', async () => {
    mockedFavorites.createFavorite.mockRejectedValue(
      new ApiError(409, 'favorite is already taken')
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useToggleFavorite(queryKeys.book(7))
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          existingId: null,
          payload: { bookId: 7 },
        })
      ).rejects.toMatchObject({ status: 409 });
    });

    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'favoriteToggled',
      detailKey: ['books', 7],
    });
  });
});

describe('useRemoveFavorite', () => {
  it('removes by the Favorite’s id and reports favoriteRemoved', async () => {
    mockedFavorites.deleteFavorite.mockResolvedValue(undefined);
    const { result, queryClient } = renderHookWithProviders(() =>
      useRemoveFavorite()
    );

    await act(() => result.current.mutateAsync(5));

    expect(mockedFavorites.deleteFavorite).toHaveBeenCalledWith(5);
    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'favoriteRemoved',
    });
  });

  it('reports favoriteRemoved after a failed call too', async () => {
    mockedFavorites.deleteFavorite.mockRejectedValue(
      new ApiError(404, 'Favorite 5 not found')
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useRemoveFavorite()
    );

    await act(async () => {
      await expect(result.current.mutateAsync(5)).rejects.toMatchObject({
        status: 404,
      });
    });

    expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
      type: 'favoriteRemoved',
    });
  });
});
