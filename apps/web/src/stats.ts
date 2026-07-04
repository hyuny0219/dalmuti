/** 계정 없이 브라우저(localStorage)에만 남는 개인 전적 */

export type PersonalStats = {
  games: number;
  wins: number;
  /** 라운드에서 1등(달무티)으로 완주한 횟수 */
  dalmutiRounds: number;
};

const KEY = 'dalmuti.stats';

export function loadStats(): PersonalStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { games: 0, wins: 0, dalmutiRounds: 0 };
    const p = JSON.parse(raw) as Partial<PersonalStats>;
    return {
      games: Number(p.games) || 0,
      wins: Number(p.wins) || 0,
      dalmutiRounds: Number(p.dalmutiRounds) || 0,
    };
  } catch {
    return { games: 0, wins: 0, dalmutiRounds: 0 };
  }
}

export function recordGameResult(won: boolean, dalmutiRounds: number): void {
  const s = loadStats();
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        games: s.games + 1,
        wins: s.wins + (won ? 1 : 0),
        dalmutiRounds: s.dalmutiRounds + dalmutiRounds,
      }),
    );
  } catch {
    /* 프라이빗 모드 등 — 전적 기록만 포기 */
  }
}
