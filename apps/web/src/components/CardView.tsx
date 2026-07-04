import type { CSSProperties } from 'react';
import { JESTER_RANK, type Card } from '@dalmuti/shared';
import { cardName, rankAccent, rankEmoji } from '../format';

export function CardView({
  card,
  selected = false,
  onClick,
  small = false,
}: {
  card: Card;
  selected?: boolean;
  onClick?: () => void;
  small?: boolean;
}) {
  const isJester = card.rank === JESTER_RANK;
  const label = isJester
    ? '광대 (와일드카드)'
    : `${card.rank} ${cardName(card.rank)}`;
  // 랭크별 고유 색상 — 테두리/핍/이름/메달리온이 이 색을 따른다
  const style = { '--accent': rankAccent(card.rank) } as CSSProperties;
  return (
    <button
      type="button"
      className={[
        'card',
        small ? 'card-small' : '',
        selected ? 'card-selected' : '',
        isJester ? 'card-jester' : '',
        onClick ? 'card-clickable' : '',
      ].join(' ')}
      onClick={onClick}
      disabled={!onClick}
      aria-label={label}
      aria-pressed={onClick ? selected : undefined}
      style={style}
    >
      <span className="card-pip" aria-hidden="true">{isJester ? '★' : card.rank}</span>
      <span className="card-emoji" aria-hidden="true">{rankEmoji(card.rank)}</span>
      <span className="card-rank">{isJester ? '★' : card.rank}</span>
      {!small && <span className="card-name">{cardName(card.rank)}</span>}
      <span className="card-pip card-pip-br" aria-hidden="true">{isJester ? '★' : card.rank}</span>
    </button>
  );
}

/** 뒷면 카드 묶음 (다른 플레이어 손패 표시용) */
export function CardBackStack({ count }: { count: number }) {
  const shown = Math.min(count, 8);
  return (
    <div className="card-back-stack" aria-label={`카드 ${count}장`}>
      {Array.from({ length: shown }, (_, i) => (
        <div key={i} className="card-back" style={{ marginLeft: i === 0 ? 0 : -14 }} />
      ))}
      <span className="card-back-count">{count}</span>
    </div>
  );
}
