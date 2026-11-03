import { act, waitFor } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import {
  useBookLibraryActions,
  useReadingProgressMutation,
  useSeriesLibraryActions,
} from './library';
import { renderHookWithProviders } from '../test/renderWithProviders';
import { ApiError } from '../api/client';
import * as libraryApi from '../api/library';
import { applyChange } from './applyChange';

jest.mock('../api/library');
jest.mock('./applyChange', () => ({ applyChange: jest.fn() }));
const mockedLibrary = jest.mocked(libraryApi);
const mockedApplyChange = jest.mocked(applyChange);

beforeEach(() => {
  jest.resetAllMocks();
  mockedApplyChange.mockResolvedValue(undefined);
});

describe('useSeriesLibraryActions', () => {
  it.each([
    ['add', 'addSeriesToLibrary'],
    ['toggleNotInterested', 'toggleSeriesNotInterested'],
    ['remove', 'removeSeriesFromLibrary'],
  ] as const)(
    'reports seriesLibraryChanged for the Series after %s succeeds',
    async (action, apiName) => {
      mockedLibrary[apiName].mockResolvedValue({
        inLibrary: false,
        notInterested: false,
      });
      const { result, queryClient } = renderHookWithProviders(() =>
        useSeriesLibraryActions(5)
      );

      await act(() => result.current[action].mutateAsync());

      expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
        type: 'seriesLibraryChanged',
        id: 5,
      });
    }
  );

  it.each([
    ['add', 'addSeriesToLibrary'],
    ['toggleNotInterested', 'toggleSeriesNotInterested'],
    ['remove', 'removeSeriesFromLibrary'],
  ] as const)(
    'reports seriesLibraryChanged even when %s fails',
    async (action, apiName) => {
      mockedLibrary[apiName].mockRejectedValue(
        new ApiError(404, 'Series 5 not found')
      );
      const { result, queryClient } = renderHookWithProviders(() =>
        useSeriesLibraryActions(5)
      );

      await act(async () => {
        await expect(
          result.current[action].mutateAsync()
        ).rejects.toMatchObject({ status: 404 });
      });

      expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
        type: 'seriesLibraryChanged',
        id: 5,
      });
    }
  );
});

describe('useReadingProgressMutation', () => {
  it.each(['opened', 'finished'] as const)(
    'reports readingProgressRecorded after %s',
    async (event) => {
      mockedLibrary.postReadingProgress.mockResolvedValue(undefined);
      const { result, queryClient } = renderHookWithProviders(() =>
        useReadingProgressMutation()
      );

      await act(() =>
        result.current.mutateAsync({
          bookId: 7,
          payload: { event, chapterId: 3 },
        })
      );

      expect(mockedApplyChange).toHaveBeenCalledTimes(1);
      expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
        type: 'readingProgressRecorded',
      });
    }
  );

  it('reports nothing when the POST fails', async () => {
    mockedLibrary.postReadingProgress.mockRejectedValue(
      new ApiError(500, 'boom')
    );
    const { result } = renderHookWithProviders(() =>
      useReadingProgressMutation()
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          bookId: 7,
          payload: { event: 'opened', chapterId: 3 },
        })
      ).rejects.toMatchObject({ status: 500 });
    });

    expect(mockedApplyChange).not.toHaveBeenCalled();
  });

  it('refetches a mounted book list after opened lifts a not_interested Book', async () => {
    const actual =
      jest.requireActual<typeof import('./applyChange')>('./applyChange');
    mockedApplyChange.mockImplementation(actual.applyChange);
    mockedLibrary.postReadingProgress.mockResolvedValue(undefined);
    const queryFn = jest.fn().mockResolvedValue([]);
    const { result, queryClient } = renderHookWithProviders(() => {
      useQuery({ queryKey: ['books', { sort: 'rating' }], queryFn });
      return useReadingProgressMutation();
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    await act(() =>
      result.current.mutateAsync({
        bookId: 7,
        payload: { event: 'opened', chapterId: 3 },
      })
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(queryClient.isFetching()).toBe(0);
  });
});

describe('useBookLibraryActions', () => {
  it.each([
    ['add', 'addBookToLibrary'],
    ['toggleNotInterested', 'toggleBookNotInterested'],
    ['remove', 'clearReadingStatus'],
  ] as const)(
    'reports bookLibraryChanged after %s succeeds',
    async (action, apiName) => {
      if (apiName === 'clearReadingStatus') {
        // The server answers 204.
        mockedLibrary.clearReadingStatus.mockResolvedValue(undefined);
      } else {
        mockedLibrary[apiName].mockResolvedValue({ bookId: 7, status: null });
      }
      const { result, queryClient } = renderHookWithProviders(() =>
        useBookLibraryActions()
      );

      await act(() => result.current[action].mutateAsync(7));

      expect(mockedLibrary[apiName]).toHaveBeenCalledWith(7);
      expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
        type: 'bookLibraryChanged',
      });
    }
  );

  it.each([
    ['add', 'addBookToLibrary'],
    ['toggleNotInterested', 'toggleBookNotInterested'],
    ['remove', 'clearReadingStatus'],
  ] as const)(
    'reports bookLibraryChanged even when %s fails, so the screen shows what exists',
    async (action, apiName) => {
      mockedLibrary[apiName].mockRejectedValue(
        new ApiError(404, 'Book 7 not found')
      );
      const { result, queryClient } = renderHookWithProviders(() =>
        useBookLibraryActions()
      );

      await act(async () => {
        await expect(
          result.current[action].mutateAsync(7)
        ).rejects.toMatchObject({ status: 404 });
      });

      expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
        type: 'bookLibraryChanged',
      });
    }
  );
});
