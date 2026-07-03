/** 재접속용 세션 정보를 localStorage에 보관 */
export type SavedSession = {
  roomCode: string;
  sessionToken: string;
  playerId: string;
  nickname: string;
  /**
   * 게임 중 "나가기"로 자발적으로 떠난 상태.
   * 서버는 좌석을 보존하므로 세션은 지우지 않되, 자동 복귀는 하지 않고
   * 홈 화면에서 수동 복귀 버튼을 보여주는 데 사용한다.
   */
  leftVoluntarily?: boolean;
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

/** 게임 중 자발적 이탈 표시 — 세션은 남기되 자동 복귀를 막는다 */
export function markSessionLeft(): void {
  const session = loadSession();
  if (session) saveSession({ ...session, leftVoluntarily: true });
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
