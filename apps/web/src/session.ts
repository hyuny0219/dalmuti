/** 재접속용 세션 정보를 localStorage에 보관 */
export type SavedSession = {
  roomCode: string;
  sessionToken: string;
  playerId: string;
  nickname: string;
};

const KEY = 'dalmuti.session';
const NICKNAME_KEY = 'dalmuti.nickname';

export function saveSession(session: SavedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // 프라이빗 모드 등 저장 불가 환경 — 재접속만 포기
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (!parsed.roomCode || !parsed.sessionToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

export function saveNickname(nickname: string): void {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {
    /* noop */
  }
}

export function loadNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}
