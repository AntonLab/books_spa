import type { FC } from 'react';
import { Alert, Button, Flex, Popconfirm, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { SortableList } from '@/components/organisms/SortableList/SortableList';
import { AddBookToSeries } from './AddBookToSeries';
import { ApiError } from '@/api/client';
import {
  useRemoveBookFromSeries,
  useReorderSeriesBooks,
  useSeriesBooks,
} from '@/queries/series';
import { BOOK_STATUS_COLORS, BOOK_STATUS_LABELS } from '@/types/book';
import type { SeriesBookSummary, SessionUser } from '@/types/api';
import { bookCapabilities } from '@/types/capabilities';
import spacing from '@/theme/spacing.module.css';

interface SeriesOrderListProps {
  seriesId: number;
  // Passed in rather than derived here: useSeriesBooks below stays disabled
  // until the page knows the viewer may edit the series, and a session this
  // component fetched itself would re-open the query before the permission is
  // known.
  mayEdit: boolean;
  session: SessionUser;
}

export const SeriesOrderList: FC<SeriesOrderListProps> = ({
  seriesId,
  mayEdit,
  session,
}) => {
  const books = useSeriesBooks(seriesId, mayEdit);
  const reorder = useReorderSeriesBooks(seriesId);
  const takeOut = useRemoveBookFromSeries(seriesId);

  const reorderConflict =
    reorder.error instanceof ApiError && reorder.error.status === 409;

  // A Draft book filed here is listed to every Co-author of the series, so they
  // can order it, but opens only for its own Co-authors and Moderators: for
  // anyone else it is named rather than linked.
  const bookRow = (book: SeriesBookSummary) => {
    const readable = bookCapabilities(book, session).mayRead;

    return (
      <Flex justify="space-between" align="center" gap="small">
        <Space wrap>
          {readable ? (
            <Link to={`/books/${book.id}`}>{book.title}</Link>
          ) : (
            <Typography.Text>{book.title}</Typography.Text>
          )}
          <Tag color={BOOK_STATUS_COLORS[book.status]}>
            {BOOK_STATUS_LABELS[book.status]}
          </Tag>
          <Typography.Text type="secondary">
            {book.authors
              .map((author) => `${author.firstName} ${author.lastName}`)
              .join(', ')}
          </Typography.Text>
        </Space>
        <Popconfirm
          title="Take this book out of the series?"
          description="The book stays. Filing it again puts it at the end."
          okText="Take it out"
          onConfirm={() => takeOut.mutate(book.id)}
        >
          <Button
            size="small"
            loading={takeOut.isPending && takeOut.variables === book.id}
          >
            Remove from series
          </Button>
        </Popconfirm>
      </Flex>
    );
  };

  return (
    <>
      {/* A 409 has already brought in the current list; this says why the
          order just moved under the author's hands. */}
      {reorder.error && (
        <Alert
          type={reorderConflict ? 'warning' : 'error'}
          title={
            reorderConflict
              ? 'A co-author changed the books of this series while you were reordering them. This is their current order.'
              : 'Could not save the new book order.'
          }
          className={spacing.gapBelow}
        />
      )}
      {takeOut.error && (
        <Alert
          type="error"
          title={takeOut.error.message}
          className={spacing.gapBelow}
        />
      )}
      {mayEdit && <AddBookToSeries seriesId={seriesId} session={session} />}
      <SortableList
        items={(books.data?.items ?? []).map((book) => ({
          id: book.id,
          label: book.title,
          content: bookRow(book),
        }))}
        isPending={books.isPending}
        isError={books.isError}
        errorText="Could not load the books of this series."
        emptyText="No books yet. Add a book to this series from the book's Edit dialog."
        onReorder={(bookIds) => reorder.mutate(bookIds)}
      />
    </>
  );
};
