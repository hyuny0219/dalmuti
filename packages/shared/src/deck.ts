import { JESTER_COUNT, JESTER_RANK, MAX_RANK, MIN_RANK } from './constants';
import type { Card } from './types';

/** 달무티 80장 덱 생성: 숫자 N 카드가 N장(1~12) + 광대 2장 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
    for (let i = 1; i <= rank; i++) {
      deck.push({ id: `r${rank}-${i}`, rank });
    }
  }
  for (let i = 1; i <= JESTER_COUNT; i++) {
    deck.push({ id: `j-${i}`, rank: JESTER_RANK });
  }
  return deck;
}

/** Fisher–Yates 셔플. rng 주입으로 테스트에서 결정적 셔플 가능 */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    // rng가 정확히 1을 반환해도 배열 범위를 벗어나지 않게 clamp
    const j = Math.min(Math.floor(rng() * (i + 1)), i);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * 한 장씩 순서대로 분배. 인원이 카드 수의 약수가 아니면 일부 좌석이 1장 더 받는다.
 * firstSeat부터 분배를 시작하므로 추가 카드를 받는 좌석을 호출자가 돌릴 수 있다
 * (고정하면 라운드 2+에서 항상 대달무티(좌석 0)에게 부담이 쏠린다).
 */
export function deal(
  deck: readonly Card[],
  numPlayers: number,
  firstSeat = 0,
): Card[][] {
  const hands: Card[][] = Array.from({ length: numPlayers }, () => []);
  deck.forEach((card, i) => {
    hands[(firstSeat + i) % numPlayers]!.push(card);
  });
  return hands;
}

/** 손패 정렬: 강한 카드(낮은 숫자)부터, 광대는 마지막 */
export function sortHand(hand: readonly Card[]): Card[] {
  return [...hand].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}
