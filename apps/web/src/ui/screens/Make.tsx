import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionBox, MemeTemplate, ProcessedImage } from '../../contracts';
import { useDebounced, usePartnerName, useServices } from '../context';
import { friendlyError } from '../errors';
import { EmptyState } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { importAndFavorite, importAndSend, useNavigate } from '../nav';

export function Make({ active }: { active: boolean }) {
  const { imgflip } = useServices();
  const [templates, setTemplates] = useState<MemeTemplate[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MemeTemplate | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active || templates) return;
    let alive = true;
    setError(null);
    imgflip.listTemplates().then(
      (t) => alive && setTemplates(t),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [active, imgflip, templates, attempt]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (templates ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [templates, query]);

  if (selected) return <Editor template={selected} onBack={() => setSelected(null)} />;

  return (
    <section className="screen make" aria-label="Make a meme">
      <header className="topbar">
        <h1 className="topbar-title big">Make</h1>
      </header>
      <div className="search-bar">
        <Icon name="search" size={18} />
        <input type="search" className="search-input" placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search templates" />
      </div>
      <div className="scroll">
        {error ? (
          <EmptyState
            emoji="📡"
            title="Couldn't load templates"
            action={
              <button type="button" className="btn btn-soft" onClick={() => (setTemplates(null), setAttempt((a) => a + 1))}>
                <Icon name="refresh" size={18} /> Try again
              </button>
            }
          >
            {friendlyError(error)}
          </EmptyState>
        ) : !templates ? (
          <div className="template-grid" aria-busy="true">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="skeleton square" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState emoji="🔍" title="No templates match">
            Try a different word.
          </EmptyState>
        ) : (
          <ul className="template-grid" aria-label="Templates">
            {filtered.map((t) => (
              <li key={t.id}>
                <button type="button" className="template" onClick={() => setSelected(t)}>
                  <span className="template-img">
                    <img src={t.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  </span>
                  <span className="template-name">{t.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="fineprint center">Captions are drawn on your phone. Nothing is uploaded to Imgflip.</p>
      </div>
    </section>
  );
}

function boxLabel(i: number, n: number): string {
  if (n === 1) return 'Caption';
  if (n === 2) return i === 0 ? 'Top text' : 'Bottom text';
  return `Text ${i + 1}`;
}

function Editor({ template, onBack }: { template: MemeTemplate; onBack: () => void }) {
  const services = useServices();
  const { images } = services;
  const partner = usePartnerName();
  const toast = useToast();
  const navigate = useNavigate();
  const [boxes, setBoxes] = useState<CaptionBox[]>(() => images.defaultBoxes(template));
  const [preview, setPreview] = useState<string>(template.url);
  const [rendering, setRendering] = useState(false);
  const [busy, setBusy] = useState<'send' | 'save' | null>(null);
  const last = useRef<{ key: string; img: ProcessedImage } | null>(null);
  const urlRef = useRef<string | null>(null);
  const debounced = useDebounced(boxes, 250);
  const hasText = boxes.some((b) => b.text.trim());

  const render = async (bs: CaptionBox[]): Promise<ProcessedImage> => {
    const key = JSON.stringify(bs.map((b) => b.text));
    if (last.current?.key === key) return last.current.img;
    const img = await images.renderMeme(template, bs);
    last.current = { key, img };
    return img;
  };

  // Live preview (debounced).
  useEffect(() => {
    if (!debounced.some((b) => b.text.trim())) {
      setPreview(template.url);
      return;
    }
    let alive = true;
    setRendering(true);
    render(debounced).then(
      (img) => {
        if (!alive) return;
        const url = URL.createObjectURL(img.blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPreview(url);
        setRendering(false);
      },
      () => alive && setRendering(false),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, template]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const title = boxes
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(' / ') || template.name;

  const finish = async (kind: 'send' | 'save') => {
    setBusy(kind);
    try {
      const img = await render(boxes);
      const input = { ...img, source: 'maker' as const, title };
      if (kind === 'send') {
        await importAndSend(services, input);
        toast.success(`Sent to ${partner}`);
        navigate('chat');
        onBack();
      } else {
        await importAndFavorite(services, input);
        toast.success('Saved to your gallery ⭐');
        setBusy(null);
      }
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't create that meme."));
      setBusy(null);
    }
  };

  return (
    <section className="screen make editor" aria-label={`Edit ${template.name}`}>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Back to templates" onClick={onBack}>
          <Icon name="back" />
        </button>
        <h1 className="topbar-title">{template.name}</h1>
      </header>
      <div className="scroll editor-scroll">
        <div className="editor-preview">
          <img src={preview} alt={hasText ? `Preview: ${title}` : template.name} width={template.width} height={template.height} />
          {rendering && <span className="spinner sm preview-spinner" aria-label="Updating preview" />}
        </div>
        <div className="card form">
          {boxes.map((b, i) => (
            <div key={i} className="field">
              <label className="label" htmlFor={`cap-${i}`}>
                {boxLabel(i, boxes.length)}
              </label>
              <input
                id={`cap-${i}`}
                className="input"
                value={b.text}
                maxLength={120}
                placeholder={i === 0 ? 'when the meme is perfect' : 'type something funny'}
                onChange={(e) => setBoxes((bs) => bs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              />
            </div>
          ))}
          {hasText && (
            <button type="button" className="link-btn small" onClick={() => setBoxes((bs) => bs.map((x) => ({ ...x, text: '' })))}>
              Clear text
            </button>
          )}
        </div>
      </div>
      <div className="editor-footer">
        <button type="button" className="btn btn-soft btn-lg" disabled={!hasText || !!busy} onClick={() => void finish('save')}>
          {busy === 'save' ? <span className="spinner sm" /> : <Icon name="star" size={18} />} Save
        </button>
        <button type="button" className="btn btn-primary btn-lg grow" disabled={!hasText || !!busy} onClick={() => void finish('send')}>
          {busy === 'send' ? <span className="spinner sm on-accent" /> : <Icon name="send" size={18} />} Send to {partner}
        </button>
      </div>
    </section>
  );
}
