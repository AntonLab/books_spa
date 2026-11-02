import { useState, type FC } from 'react';
import { Button, Tabs } from 'antd';
import { useNavigate, useSearchParams } from 'react-router';
import { BookCreateModal } from '@/components/organisms/BookCreateModal/BookCreateModal';
import { SeriesCreateModal } from '@/components/organisms/SeriesCreateModal/SeriesCreateModal';
import { SeriesEditDetailsModal } from '@/components/organisms/SeriesEditDetailsModal/SeriesEditDetailsModal';
import { EDIT_PARAM, EDIT_PARAM_OPEN } from '@/constants/editParam';
import type { ProfileScope } from '@/types/profileScope';
import { ProfileBooksList } from './ProfileBooksList';
import { ProfileSeriesList } from './ProfileSeriesList';
import { profileTabOf } from './useProfileLists';

interface Props {
  scope: ProfileScope;
  // An Account holding the author Role when scope is 'mine': the caller gates
  // on it. Favorites ignores it.
  viewerId: number;
}

export const ProfileWorksPanel: FC<Props> = ({ scope, viewerId }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState<'book' | 'series' | null>(null);
  const [editingSeriesId, setEditingSeriesId] = useState<number | null>(null);
  const navigate = useNavigate();

  // The inner tab lives in the URL (`?tab=series`) because each list keeps its
  // filters there too. That departs from ADR-0010 for these two panels.
  // Replacing the whole query string drops every filter, `page` and
  // `pageSize`, so the other list never inherits them.
  const onChange = (key: string) =>
    setSearchParams(key === 'series' ? { tab: 'series' } : {});

  const tab = profileTabOf(searchParams);

  return (
    <>
      <Tabs
        activeKey={tab}
        tabBarExtraContent={
          scope === 'mine' &&
          (tab === 'series' ? (
            <Button onClick={() => setCreating('series')}>Create series</Button>
          ) : (
            <Button type="primary" onClick={() => setCreating('book')}>
              Create book
            </Button>
          ))
        }
        onChange={onChange}
        destroyOnHidden
        items={[
          {
            key: 'books',
            label: 'Books',
            children: (
              <ProfileBooksList
                scope={scope}
                viewerId={viewerId}
                onEdit={(id) =>
                  void navigate(`/books/${id}?${EDIT_PARAM}=${EDIT_PARAM_OPEN}`)
                }
              />
            ),
          },
          {
            key: 'series',
            label: 'Series',
            children: (
              <ProfileSeriesList
                scope={scope}
                viewerId={viewerId}
                onEdit={setEditingSeriesId}
              />
            ),
          },
        ]}
      />
      {creating === 'book' && (
        <BookCreateModal
          authorId={viewerId}
          onClose={() => setCreating(null)}
        />
      )}
      {creating === 'series' && (
        <SeriesCreateModal onClose={() => setCreating(null)} />
      )}
      {editingSeriesId !== null && (
        <SeriesEditDetailsModal
          seriesId={editingSeriesId}
          onClose={() => setEditingSeriesId(null)}
        />
      )}
    </>
  );
};
