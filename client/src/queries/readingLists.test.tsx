import { act, waitFor } from '@testing-library/react';
import {
  useCopyReadingList,
  useCreateReadingList,
  useDeleteReadingList,
  useMyReadingLists,
  useReadingListItems,
  useReadingListsByBook,
  useRemoveReadingListItem,
  useReorderReadingListItems,
  useToggleListItem,
  useUpdateReadingList,
} from './readingLists';
import { queryKeys } from './keys';
import { renderHookWithProviders } from '../test/renderWithProviders';
import { ApiError } from '../api/client';
import * as readingListsApi from '../api/readingLists';
import { applyChange } from './applyChange';
import type { ReadingListItem } from '../types/readingList';

jest.mock('../api/readingLists');
jest.mock('./applyChange', () => ({ applyChange: jest.fn() }));
const mocked = jest.mocked(readingListsApi);
const mockedApplyChange = jest.mocked(applyChange);

const item = {
  id: 9,
  position: 0,
  bookId: 7,
  seriesId: null,
} as unknown as ReadingListItem;

beforeEach(() => {
  jest.resetAllMocks();
  mockedApplyChange.mockResolvedValue(undefined);
  mocked.addReadingListItem.mockResolvedValue(item);
  mocked.removeReadingListItem.mockResolvedValue(undefined);
  mocked.createReadingList.mockResolvedValue({} as never);
  mocked.updateReadingList.mockResolvedValue({} as never);
  mocked.deleteReadingList.mockResolvedValue(undefined);
  mocked.copyReadingList.mockResolvedValue({} as never);
  mocked.reorderReadingListItems.mockResolvedValue(undefined);
  mocked.listMyReadingLists.mockResolvedValue({ items: [] });
  mocked.listReadingListItems.mockResolvedValue({ items: [] });
});

it('useToggleListItem adds to the list with itemId null, removes with a number, and reports a change each time', async () => {
  const { result, queryClient } = renderHookWithProviders(() =>
    useToggleListItem({ bookId: 7 })
  );
  await act(() => result.current.mutateAsync({ listId: 4, itemId: null }));
  expect(mocked.addReadingListItem).toHaveBeenCalledWith(4, { bookId: 7 });
  expect(mockedApplyChange).toHaveBeenCalledTimes(1);
  await act(() => result.current.mutateAsync({ listId: 4, itemId: 9 }));
  expect(mocked.removeReadingListItem).toHaveBeenCalledWith(4, 9);
  expect(mockedApplyChange).toHaveBeenCalledTimes(2);
  expect(mockedApplyChange).toHaveBeenLastCalledWith(queryClient, {
    type: 'readingListChanged',
  });
});

it('useToggleListItem reports a change even when the add is refused with a 409', async () => {
  mocked.addReadingListItem.mockRejectedValue(new ApiError(409, 'Conflict'));
  const { result, queryClient } = renderHookWithProviders(() =>
    useToggleListItem({ bookId: 7 })
  );
  await act(() =>
    result.current
      .mutateAsync({ listId: 4, itemId: null })
      .catch(() => undefined)
  );
  expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
    type: 'readingListChanged',
  });
});

it('useRemoveReadingListItem reports a change on success and after a failed call', async () => {
  const first = renderHookWithProviders(() => useRemoveReadingListItem(4));
  await act(() => first.result.current.mutateAsync(9));
  expect(mockedApplyChange).toHaveBeenCalledWith(first.queryClient, {
    type: 'readingListChanged',
  });

  mockedApplyChange.mockClear();
  mocked.removeReadingListItem.mockRejectedValue(new ApiError(404, 'Gone'));
  const second = renderHookWithProviders(() => useRemoveReadingListItem(4));
  await act(() => second.result.current.mutateAsync(9).catch(() => undefined));
  expect(mockedApplyChange).toHaveBeenCalledWith(second.queryClient, {
    type: 'readingListChanged',
  });
});

it.each([
  [
    'create',
    () => useCreateReadingList(),
    { title: 'T', description: '', tags: [] },
  ],
  ['update', () => useUpdateReadingList(4), { title: 'U' }],
  ['copy', () => useCopyReadingList(), 4],
])('%s reports a readingListChanged', async (_name, useHook, variables) => {
  const { result, queryClient } = renderHookWithProviders(
    () => useHook() as never
  );
  await act(() =>
    (
      result.current as { mutateAsync: (v: unknown) => Promise<unknown> }
    ).mutateAsync(variables)
  );
  expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
    type: 'readingListChanged',
  });
});

it('a failed useUpdateReadingList reports nothing', async () => {
  mocked.updateReadingList.mockRejectedValue(new ApiError(400, 'Bad'));
  const { result } = renderHookWithProviders(() => useUpdateReadingList(4));
  await act(() => result.current.mutateAsync({ title: 'U' }).catch(() => {}));
  expect(mockedApplyChange).not.toHaveBeenCalled();
});

it('useDeleteReadingList reports readingListDeleted on success and readingListDeleteFailed after a failure', async () => {
  const first = renderHookWithProviders(() => useDeleteReadingList(7));
  await act(() => first.result.current.mutateAsync());
  expect(mockedApplyChange).toHaveBeenCalledWith(first.queryClient, {
    type: 'readingListDeleted',
    id: 7,
  });

  mockedApplyChange.mockClear();
  mocked.deleteReadingList.mockRejectedValue(new ApiError(404, 'Not Found'));
  const second = renderHookWithProviders(() => useDeleteReadingList(7));
  await act(() => second.result.current.mutateAsync().catch(() => undefined));
  expect(mockedApplyChange).toHaveBeenCalledTimes(1);
  expect(mockedApplyChange).toHaveBeenCalledWith(second.queryClient, {
    type: 'readingListDeleteFailed',
  });
});

it('useReorderReadingListItems rewrites the cached items at once and sends the ids', async () => {
  const rows = [
    { id: 1, kind: 'unavailable' as const },
    { id: 2, kind: 'unavailable' as const },
  ];
  const { result, queryClient } = renderHookWithProviders(() =>
    useReorderReadingListItems(4)
  );
  queryClient.setQueryData(queryKeys.readingListItems(4), { items: rows });
  await act(() => result.current.mutateAsync([2, 1]));
  expect(mocked.reorderReadingListItems).toHaveBeenCalledWith(4, [2, 1]);
  expect(mockedApplyChange).toHaveBeenCalledWith(queryClient, {
    type: 'listReordered',
    keys: [queryKeys.readingListItems(4), queryKeys.allReadingLists],
  });
  const cached = queryClient.getQueryData<{ items: { id: number }[] }>(
    queryKeys.readingListItems(4)
  );
  expect(cached?.items.map((row) => row.id)).toEqual([2, 1]);
});

it.each([
  [
    'useMyReadingLists',
    () => useMyReadingLists({ bookId: 7 }, false),
    () => mocked.listMyReadingLists,
  ],
  [
    'useReadingListItems',
    () => useReadingListItems(4, false),
    () => mocked.listReadingListItems,
  ],
])('%s stays idle while disabled', (_name, useHook, api) => {
  renderHookWithProviders(() => useHook() as never);
  expect(api()).not.toHaveBeenCalled();
});

it('useReadingListsByBook asks for the Book at the given page and refetches when an item is added to any list', async () => {
  mocked.listReadingLists.mockResolvedValue({
    items: [],
    total: 0,
    current: 2,
    pageSize: 10,
  });
  mockedApplyChange.mockImplementation((client) =>
    client.invalidateQueries({ queryKey: queryKeys.allReadingLists })
  );
  const { result } = renderHookWithProviders(() => ({
    lists: useReadingListsByBook(7, 2, 10),
    add: useToggleListItem({ bookId: 7 }),
  }));
  await waitFor(() => expect(result.current.lists.isSuccess).toBe(true));
  expect(mocked.listReadingLists).toHaveBeenCalledWith({
    bookId: 7,
    current: 2,
    pageSize: 10,
  });

  await act(() => result.current.add.mutateAsync({ listId: 4, itemId: null }));

  await waitFor(() => expect(mocked.listReadingLists).toHaveBeenCalledTimes(2));
});
