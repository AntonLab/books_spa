import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useCreateChapter,
  useDeleteChapter,
  useUpdateChapter,
} from './chapters';
import { createTestQueryClient } from '../test/queryClient';
import * as chaptersApi from '../api/chapters';
import { applyChange } from './applyChange';
import type { PublicChapter } from '../types/chapter';

jest.mock('../api/chapters');
jest.mock('./applyChange', () => ({ applyChange: jest.fn() }));

const mockedChapters = jest.mocked(chaptersApi);
const mockedApplyChange = jest.mocked(applyChange);

const chapter: PublicChapter = {
  id: 9,
  bookId: 1,
  title: 'Chapter One',
  text: 'It was a dark night.',
  publishedAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const setUp = () => {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'QueryClientWrapper';

  return {
    client,
    wrapper: Wrapper,
  };
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedApplyChange.mockResolvedValue(undefined);
  mockedChapters.createChapter.mockResolvedValue(chapter);
  mockedChapters.updateChapter.mockResolvedValue(chapter);
  mockedChapters.deleteChapter.mockResolvedValue(undefined);
});

describe('chapter writes', () => {
  it('publishing a new chapter reports a chapterChanged', async () => {
    const { client, wrapper } = setUp();
    const { result } = renderHook(() => useCreateChapter(1), { wrapper });

    result.current.mutate({
      bookId: 1,
      title: 'Chapter One',
      text: 'It was a dark night.',
      publishedAt: 'now',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApplyChange).toHaveBeenCalledWith(client, {
      type: 'chapterChanged',
      bookId: 1,
    });
  });

  it('does not wait for applyChange: a never-resolving refresh still ends the mutation', async () => {
    mockedApplyChange.mockReturnValue(new Promise(() => {}));
    const { wrapper } = setUp();
    const { result } = renderHook(() => useUpdateChapter(1, 9), { wrapper });

    result.current.mutate({ text: 'x', expectedUpdatedAt: 'y' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('saving a chapter reports a chapterChanged', async () => {
    const { client, wrapper } = setUp();
    const { result } = renderHook(() => useUpdateChapter(1, 9), { wrapper });

    result.current.mutate({
      text: 'It was a dark and stormy night.',
      expectedUpdatedAt: '2026-09-03T00:00:00.000Z',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedChapters.updateChapter).toHaveBeenCalledWith(9, {
      text: 'It was a dark and stormy night.',
      expectedUpdatedAt: '2026-09-03T00:00:00.000Z',
    });
    expect(mockedApplyChange).toHaveBeenCalledWith(client, {
      type: 'chapterChanged',
      bookId: 1,
    });
  });

  it('a failed save reports nothing', async () => {
    mockedChapters.updateChapter.mockRejectedValue(new Error('boom'));
    const { wrapper } = setUp();
    const { result } = renderHook(() => useUpdateChapter(1, 9), { wrapper });

    result.current.mutate({ text: 'x', expectedUpdatedAt: 'y' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApplyChange).not.toHaveBeenCalled();
  });

  it('a failed create reports nothing', async () => {
    mockedChapters.createChapter.mockRejectedValue(new Error('boom'));
    const { wrapper } = setUp();
    const { result } = renderHook(() => useCreateChapter(1), { wrapper });

    result.current.mutate({
      bookId: 1,
      title: 'Chapter One',
      text: 'x',
      publishedAt: 'now',
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApplyChange).not.toHaveBeenCalled();
  });

  it('a failed delete reports nothing', async () => {
    mockedChapters.deleteChapter.mockRejectedValue(new Error('boom'));
    const { wrapper } = setUp();
    const { result } = renderHook(() => useDeleteChapter(1, 9), { wrapper });

    result.current.mutate(undefined);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockedApplyChange).not.toHaveBeenCalled();
  });

  it('deleting a chapter reports a chapterDeleted with the book and chapter ids', async () => {
    const { client, wrapper } = setUp();
    const { result } = renderHook(() => useDeleteChapter(1, 9), { wrapper });

    result.current.mutate(undefined);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedChapters.deleteChapter).toHaveBeenCalledWith(9);
    expect(mockedApplyChange).toHaveBeenCalledWith(client, {
      type: 'chapterDeleted',
      bookId: 1,
      id: 9,
    });
  });
});
