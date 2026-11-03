import type { FC } from 'react';
import { Alert, Button, Divider, Popconfirm, Space } from 'antd';
import { BookCoverManager } from '@/components/organisms/BookCoverManager/BookCoverManager';
import { CoAuthorManager } from '@/components/organisms/CoAuthorManager/CoAuthorManager';
import { DELETE_BOOK_CONFIRM } from '@/constants/deleteWork';
import { useDeleteBook } from '@/queries/books';
import { bookCapabilities } from '@/types/capabilities';
import type { BookDetail } from '@/types/book';
import type { SessionUser } from '@/types/api';

interface BookDetailsExtrasProps {
  book: BookDetail;
  session: SessionUser;
  onGone: () => void;
}

// What sits under the Details form: Cover, Co-authors and Delete book.
export const BookDetailsExtras: FC<BookDetailsExtrasProps> = ({
  book,
  session,
  onGone,
}) => {
  const remove = useDeleteBook(book.id);
  // A Moderator may edit and delete any book, but never change its byline —
  // CoAuthorManager stays read-only for one.
  const { isCoAuthor } = bookCapabilities(book, session);

  return (
    <>
      <Divider />

      <BookCoverManager
        bookId={book.id}
        coverUrl={book.coverUrl}
        title={book.title}
      />

      <Divider />

      <CoAuthorManager
        work={{ kind: 'book', id: book.id }}
        authors={book.authors}
        viewerId={session.id}
        canManage={isCoAuthor}
        onLeave={onGone}
      />

      <Divider />

      <Space orientation="vertical">
        {remove.error && <Alert type="error" title={remove.error.message} />}
        <Popconfirm
          {...DELETE_BOOK_CONFIRM}
          okButtonProps={{ danger: true }}
          onConfirm={() => remove.mutate(undefined, { onSuccess: onGone })}
        >
          <Button danger loading={remove.isPending}>
            Delete book
          </Button>
        </Popconfirm>
      </Space>
    </>
  );
};
