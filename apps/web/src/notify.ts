/**
 * 내 차례 알림: 알림음(WebAudio) + 백그라운드 탭 제목 깜빡임 + 모바일 진동.
 * 턴제 게임 특성상 다른 탭/앱을 보다 차례를 놓치는 게 가장 흔한 불편이라
 * 브라우저 내장 API만으로 가볍게 해결한다 (권한 팝업이 필요한 Notification은 쓰지 않는다).
 */

const SOUND_KEY = 'dalmuti.soundOn';

export function isSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* noop */
  }
}

let audioCtx: AudioContext | null = null;

/** 짧은 2음 차임 — 오디오 파일 없이 WebAudio로 합성 (자산 0KB) */
function playChime(): void {
  try {
    audioCtx ??= new AudioContext();
    // 자동재생 정책으로 suspend된 컨텍스트는 사용자 제스처 후 재개된다
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const now = audioCtx.currentTime;
    for (const [freq, at] of [
      [740, 0],
      [988, 0.12],
    ] as const) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.4);
    }
  } catch {
    // 오디오 불가 환경 (권한/정책) — 알림음만 포기
  }
}

let titleFlashTimer: ReturnType<typeof setInterval> | null = null;
const originalTitle = typeof document !== 'undefined' ? document.title : '';

function stopTitleFlash(): void {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
    document.title = originalTitle;
  }
}

/** 탭이 백그라운드일 때 제목을 깜빡여 주의를 끈다. 탭으로 돌아오면 원복 */
function flashTitle(text: string): void {
  stopTitleFlash();
  if (!document.hidden) return;
  let on = false;
  titleFlashTimer = setInterval(() => {
    on = !on;
    document.title = on ? text : originalTitle;
  }, 1000);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopTitleFlash();
  });
}

/** 내가 행동할 차례가 되었을 때 (플레이/세금 반환/혁명 선택 공통) */
export function notifyMyTurn(label = '🔔 내 차례!'): void {
  if (isSoundOn()) playChime();
  flashTitle(`${label} — 달무티`);
  try {
    navigator.vibrate?.([180, 80, 180]);
  } catch {
    /* noop */
  }
}
