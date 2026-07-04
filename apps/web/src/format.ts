import { RANK_NAMES_KO, type SocialRank } from '@dalmuti/shared';

/** 카드 숫자(1~13) → 이름 */
export function cardName(rank: number): string {
  return RANK_NAMES_KO[rank] ?? String(rank);
}

/** 카드 숫자 → 캐릭터 (신분에 어울리는 인물/상징) */
export const RANK_EMOJI: Record<number, string> = {
  1: '👑', // 달무티
  2: '⛪', // 대주교
  3: '🗝️', // 시종장
  4: '👸', // 남작부인
  5: '📿', // 수녀원장
  6: '⚔️', // 기사
  7: '🧵', // 재봉사
  8: '🧱', // 석공
  9: '🍳', // 요리사
  10: '🐑', // 양치기
  11: '⛏️', // 광부
  12: '🌾', // 농노
  13: '🃏', // 광대
};

/**
 * 카드 숫자 → 고유 색상 (테두리·핍·이름에 적용).
 * 강한 신분일수록 금·보라 계열, 낮을수록 흙·밀 계열 — 손패에서
 * 같은 숫자 그룹이 색으로 한눈에 묶여 보이도록 랭크마다 구분되는 색을 쓴다.
 */
export const RANK_ACCENT: Record<number, string> = {
  1: '#b8912c', // 금
  2: '#8a4bbd', // 자주
  3: '#c04a6b', // 다홍
  4: '#c25a8a', // 장미
  5: '#5b5bd6', // 남색
  6: '#3f7fc1', // 강철 청
  7: '#2fa7a0', // 청록
  8: '#6b7f95', // 석회 회청
  9: '#d07a2e', // 주황
  10: '#5f9e4f', // 초원 녹
  11: '#a1662f', // 청동
  12: '#8d7a4a', // 밀짚
  13: '#a566ef', // 보라 (광대)
};

export function rankEmoji(rank: number): string {
  return RANK_EMOJI[rank] ?? '🎴';
}

export function rankAccent(rank: number): string {
  return RANK_ACCENT[rank] ?? '#b8912c';
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
