import { useEffect, useState } from 'react';
import type { LibraryMeme } from '../../contracts';
import { useDebounced, useLibraryVersion, useProfile, useServices } from '../context';
import { EmptyState, Segmented } from '../components/Controls';
import { Icon } from '../components/Icon';
import { MemeImage, MemeViewer } from '../components/Meme';
import { useNavigate } from '../nav';

type Filter = 'all' | 'favorites';

export function Gallery({ active }: { active: boolean }) {
  const { library } = useServices();
  const version = useLibraryVersion();
  const profile = useProfile();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 200);
  const [items, setItems] = useState<LibraryMeme[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    library.list({ favoritesOnly: filter === 'favorites', query: q.trim() || undefined }).then(
      (xs) => alive && setItems(xs),
      () => alive && setItems([]),
    );
    return () => {
      alive = false;
    };
  }, [library, version, filter, q, active]);

  const searching = !!q.trim();

  return (
    <section className="screen gallery" aria-label="Gallery">
      <header className="topbar">
        <h1 className="topbar-title big">Gallery</h1>
        {items && items.length > 0 && <span className="count-pill">{items.length}</span>}
      </header>
      <div className="gallery-controls">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'favorites', label: '★ Favorites' },
          ]}
        />
        <div className="search-bar compact">
          <Icon name="search" size={18} />
          <input type="search" className="search-input" placeholder="Search by title" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search memes" />
        </div>
      </div>
      <div className="scroll">
        {items === null ? (
          <div className="gallery-grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton square" />
            ))}
          </div>
        ) : items.length === 0 ? (
          searching ? (
            <EmptyState emoji="🔍" title="No matches">
              Nothing in your {filter === 'favorites' ? 'favorites' : 'gallery'} matches “{q}”.
            </EmptyState>
          ) : filter === 'favorites' ? (
            <EmptyState emoji="⭐" title="No favorites yet">
              Open any meme and tap Favorite to keep it here.
            </EmptyState>
          ) : (
            <EmptyState
              emoji="🖼️"
              title="Your gallery is empty"
              action={
                <button type="button" className="btn btn-soft" onClick={() => navigate('discover')}>
                  <Icon name="compass" size={18} /> Discover memes
                </button>
              }
            >
              Every meme you send, receive or save lands here, on this device only.
            </EmptyState>
          )
        ) : (
          <ul className="gallery-grid" aria-label={filter === 'favorites' ? 'Favorite memes' : 'All memes'}>
            {items.map((m) => (
              <li key={m.id}>
                <button type="button" className="gallery-tile" onClick={() => setOpen(m.id)} aria-label={m.title ?? 'Meme'}>
                  <MemeImage memeId={m.id} fit="cover" alt="" />
                  {m.favorite && (
                    <span className="fav-badge" aria-label="Favorite">
                      ★
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && (
        <MemeViewer
          memeId={open}
          onClose={() => setOpen(null)}
          actions={{ send: !!profile?.paired, favorite: true, remove: true }}
          onSent={() => {
            setOpen(null);
            navigate('chat');
          }}
        />
      )}
    </section>
  );
}
