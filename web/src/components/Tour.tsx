import { useEffect, useState } from 'react';
import { useI18n, type TranslationKey } from '../i18n';

interface TourStep {
  selector: string;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
}

const STEPS: TourStep[] = [
  { selector: '.office', titleKey: 'tour1Title', bodyKey: 'tour1Body' },
  { selector: '.roster', titleKey: 'tour2Title', bodyKey: 'tour2Body' },
  { selector: '.commandbar', titleKey: 'tour3Title', bodyKey: 'tour3Body' },
  { selector: '.chart-panel', titleKey: 'tour4Title', bodyKey: 'tour4Body' },
  { selector: '.meter', titleKey: 'tour5Title', bodyKey: 'tour5Body' },
  { selector: '#tool-book', titleKey: 'tour6Title', bodyKey: 'tour6Body' },
  { selector: '#tool-ops', titleKey: 'tour7Title', bodyKey: 'tour7Body' },
  { selector: '#venue-keys-trigger', titleKey: 'tour8Title', bodyKey: 'tour8Body' },
  { selector: '#setup-trigger', titleKey: 'tour9Title', bodyKey: 'tour9Body' }
];

interface BoxRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<BoxRect | null>(null);

  const step = STEPS[idx] ?? STEPS[0];

  useEffect(() => {
    if (!open) return;
    setIdx(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const el = document.querySelector<HTMLElement>(step.selector);
      if (!el) {
        setRect(null);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const r = el.getBoundingClientRect();
      setRect({
        top: Math.max(4, r.top - 4),
        left: Math.max(4, r.left - 4),
        width: Math.min(window.innerWidth - 8, r.width + 8),
        height: r.height + 8
      });
    };
    updatePosition();
    const timer = window.setTimeout(updatePosition, 180);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, idx, step.selector]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIdx((i) => (i + 1 < STEPS.length ? i + 1 : i));
      else if (e.key === 'ArrowLeft') setIdx((i) => (i > 0 ? i - 1 : 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const cardW = Math.min(360, vw - 24);
  const cardH = 210;

  let cardTop = Math.round(vh / 2 - cardH / 2);
  let cardLeft = Math.round(vw / 2 - cardW / 2);
  let arrowDir: 'up' | 'down' | 'left' | 'right' = 'up';

  if (rect) {
    const spaceBelow = vh - (rect.top + rect.height);
    const spaceAbove = rect.top;
    if (spaceBelow >= cardH + 20) {
      cardTop = rect.top + rect.height + 14;
      cardLeft = Math.min(Math.max(12, rect.left + rect.width / 2 - cardW / 2), vw - cardW - 12);
      arrowDir = 'up';
    } else if (spaceAbove >= cardH + 20) {
      cardTop = Math.max(12, rect.top - cardH - 14);
      cardLeft = Math.min(Math.max(12, rect.left + rect.width / 2 - cardW / 2), vw - cardW - 12);
      arrowDir = 'down';
    } else if (rect.left > vw / 2) {
      cardTop = Math.min(Math.max(12, rect.top), vh - cardH - 12);
      cardLeft = Math.max(12, rect.left - cardW - 16);
      arrowDir = 'right';
    } else {
      cardTop = Math.min(Math.max(12, rect.top), vh - cardH - 12);
      cardLeft = Math.min(vw - cardW - 12, rect.left + rect.width + 16);
      arrowDir = 'left';
    }
  }

  const isLast = idx === STEPS.length - 1;

  return (
    <div className="tour-layer" role="dialog" aria-modal="false" aria-label={t('tutorial')}>
      {rect && (
        <div
          className="tour-spotlight"
          style={{
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`
          }}
        />
      )}
      <div
        className={`tour-card arrow-${arrowDir}`}
        style={{ top: `${cardTop}px`, left: `${cardLeft}px`, width: `${cardW}px` }}
      >
        <div className="tour-card-head">
          <span className="tour-step-badge">
            {idx + 1} {t('tourStepOf')} {STEPS.length}
          </span>
          <button className="tour-skip-btn" onClick={onClose}>
            {t('tourSkip')} ✕
          </button>
        </div>
        <h3>{t(step.titleKey)}</h3>
        <p>{t(step.bodyKey)}</p>
        <div className="tour-dots">
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`tour-dot ${i === idx ? 'on' : ''}`}
              aria-label={`step ${i + 1}`}
              onClick={() => setIdx(i)}
            />
          ))}
        </div>
        <div className="tour-card-actions">
          <button disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>
            ← {t('tourBack')}
          </button>
          {isLast ? (
            <button className="primary" onClick={onClose}>
              {t('tourDone')} ✓
            </button>
          ) : (
            <button className="primary" onClick={() => setIdx((i) => Math.min(STEPS.length - 1, i + 1))}>
              {t('tourNext')} →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
