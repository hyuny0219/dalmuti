import { JESTER_RANK, type Card } from '@dalmuti/shared';
import { cardName } from '../format';

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
    >
      <span className="card-rank">{isJester ? '★' : card.rank}</span>
      {!small && <span className="card-name">{cardName(card.rank)}</span>}
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
