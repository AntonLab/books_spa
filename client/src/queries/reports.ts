import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { ReportPayload } from 'shared';
import {
  dismissReport,
  getReportStatistics,
  listReports,
  reportComment,
  takeReport,
  upholdReport,
} from '../api/reports';
import type { ListReportsParams, ReportRange } from '../api/reports';
import { blockUser } from '../api/users';
import { applyChange } from './applyChange';
import { queryKeys } from './keys';

export const useReports = (params: ListReportsParams, enabled = true) => {
  return useQuery({
    queryKey: queryKeys.reports(params),
    queryFn: () => listReports(params),
    placeholderData: keepPreviousData,
    enabled,
  });
};

export const useReportStatistics = (range: ReportRange, enabled = true) => {
  return useQuery({
    queryKey: queryKeys.reportStatistics(range),
    queryFn: () => getReportStatistics(range),
    enabled,
  });
};

export const useReportComment = (bookId: number) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      commentId,
      payload,
    }: {
      commentId: number;
      payload: ReportPayload;
    }) => reportComment(commentId, payload),
    onSuccess: () =>
      applyChange(queryClient, { type: 'commentChanged', bookId }),
  });
};

interface ReportAction {
  commentId: number;
  bookId: number;
}

// Invalidates on settle, not on success: a 409 means another Moderator got
// there first, and the rows must show who.
const useReportAction = (
  mutationFn: (commentId: number) => Promise<void>,
  alsoRefreshBook = false
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ commentId }: ReportAction) => mutationFn(commentId),
    onSettled: (_data, _error, { bookId }) =>
      applyChange(queryClient, {
        type: 'reportSettled',
        bookId,
        refreshBook: alsoRefreshBook,
      }),
  });
};

export const useTakeReport = () => useReportAction(takeReport);

// The Comment became a Tombstone, which the book's commentCount reflects.
export const useUpholdReport = () => useReportAction(upholdReport, true);

export const useDismissReport = () => useReportAction(dismissReport);

export const useBanAccount = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (userId: number) => blockUser(userId),
    onSuccess: () => applyChange(queryClient, { type: 'reportsChanged' }),
  });
};
