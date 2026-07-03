import { RANK_NAMES_KO, type SocialRank } from '@dalmuti/shared';

/** 카드 숫자(1~13) → 이름 */
export function cardName(rank: number): string {
  return RANK_NAMES_KO[rank] ?? String(rank);
}

export const SOCIAL_RANK_LABELS: Record<SocialRank, { label: string; emoji: string }> = {
  GREATER_DALMUTI: { label: '대달무티', emoji: '👑' },
  LESSER_DALMUTI: { label: '소달무티', emoji: '🎩' },
  MERCHANT: { label: '상인', emoji: '⚖️' },
  LESSER_PEON: { label: '소농노', emoji: '🥾' },
  GREATER_PEON: { label: '대농노', emoji: '⛓️' },
};

export function placeMedal(place: number | null): string {
  if (place === 1) return '🥇';
  if (place === 2) return '🥈';
  if (place === 3) return '🥉';
  return place ? `${place}등` : '';
}
