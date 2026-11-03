import type { FC } from 'react';
import { EditOutlined } from '@ant-design/icons';
import { App, Space, theme } from 'antd';
import { IconButton } from '@/components/molecules/IconButton/IconButton';
import { FavoriteButton } from '@/components/molecules/FavoriteButton/FavoriteButton';
import { LibraryButtons } from '@/components/molecules/LibraryButtons/LibraryButtons';
import { LikeButton } from '@/components/molecules/LikeButton/LikeButton';
import { AddToReadingList } from '@/components/organisms/AddToReadingList/AddToReadingList';
import { useToggleFavorite } from '@/queries/favorites';
import { queryKeys } from '@/queries/keys';
import { useBookLibraryActions } from '@/queries/library';
import { useToggleLike } from '@/queries/likes';
import {
  mayAddBookToReadingList,
  type bookCapabilities,
} from '@/types/capabilities';
import type { BookDetail } from '@/types/book';
import type { SessionUser } from '@/types/api';

interface BookActionsProps {
  book: BookDetail;
  session: SessionUser | null | undefined;
  capabilities: ReturnType<typeof bookCapabilities>;
  onEdit: () => void;
}

export const BookActions: FC<BookActionsProps> = ({
  book,
  session,
  capabilities: { mayEdit, mayLike, mayFavorite, mayKeepInLibrary },
  onEdit,
}) => {
  const { token } = theme.useToken();
  const toggleLike = useToggleLike(queryKeys.book(book.id));
  const toggleFavorite = useToggleFavorite(queryKeys.book(book.id));
  const libraryActions = useBookLibraryActions();
  const { message } = App.useApp();
  const toastError = (error: Error) => void message.error(error.message);

  const status = book.viewerReadingStatus;
  // not_interested is not "in the Library": the Book can be added from it.
  const inLibrary = status !== null && status !== 'not_interested';
  // The server answers 409 for Not interested from these two.
  const keptAsReader = status === 'reading' || status === 'read';

  return (
    <Space size={token.marginSM} wrap>
      {mayLike && (
        <LikeButton
          likedId={book.viewerLikeId}
          onToggle={(existingId) =>
            toggleLike.mutate({
              existingId,
              payload: { bookId: book.id, isLike: true },
            })
          }
        />
      )}
      {mayFavorite && (
        <FavoriteButton
          favoriteId={book.viewerFavoriteId}
          // A second click before the refetch lands would send the
          // same add twice and meet a 409.
          disabled={toggleFavorite.isPending}
          onToggle={(existingId) =>
            toggleFavorite.mutate({
              existingId,
              payload: { bookId: book.id },
            })
          }
        />
      )}
      {mayKeepInLibrary && (
        <LibraryButtons
          inLibrary={inLibrary}
          notInterested={status === 'not_interested'}
          disabled={libraryActions.isPending}
          keptAsReader={keptAsReader}
          addLabel="Add to Library"
          removeLabel="Remove from Library"
          onAdd={() =>
            libraryActions.add.mutate(book.id, { onError: toastError })
          }
          onRemove={() =>
            libraryActions.remove.mutate(book.id, { onError: toastError })
          }
          onToggleNotInterested={() =>
            libraryActions.toggleNotInterested.mutate(book.id, {
              onError: toastError,
            })
          }
        />
      )}
      {mayAddBookToReadingList(book, session) && (
        <AddToReadingList target={{ bookId: book.id }} />
      )}
      {mayEdit && (
        <IconButton
          type="text"
          size="small"
          label="Edit"
          icon={<EditOutlined aria-hidden />}
          onClick={onEdit}
        />
      )}
    </Space>
  );
};
