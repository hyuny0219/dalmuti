import { useEffect, useRef, useState } from 'react';
import { MAX_CHAT_LENGTH } from '@dalmuti/shared';
import { useStore } from '../store';

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const sendChat = useStore((s) => s.sendChat);
  const me = useStore((s) => s.me);
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prevChatLen = useRef(0);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // 새 메시지 도착 시: 접혀 있으면 미읽음 증가, 펼쳐져 있으면
  // (사용자가 위로 스크롤해 읽는 중이 아닐 때만) 아래로 스크롤
  useEffect(() => {
    const added = chat.length - prevChatLen.current;
    prevChatLen.current = chat.length;
    if (added <= 0) return;
    if (collapsedRef.current) {
      setUnread((n) => n + added);
      return;
    }
    const el = listRef.current;
    if (el) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) el.scrollTo({ top: el.scrollHeight });
    }
  }, [chat]);

  // 패널을 펼치면 미읽음 초기화 + 최신 메시지로 이동
  useEffect(() => {
    if (!collapsed) {
      setUnread(0);
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [collapsed]);

  const submit = async () => {
    if (await sendChat(input)) setInput('');
  };

  return (
    <div className={`chat-panel ${collapsed ? 'chat-collapsed' : ''}`}>
      <button
        type="button"
        className="chat-toggle"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        💬 채팅
        {collapsed && unread > 0 && <span className="chat-badge">{unread}</span>}
        <span className="chat-toggle-arrow">{collapsed ? '▲' : '▼'}</span>
      </button>
      {!collapsed && (
        <>
          <div className="chat-list" ref={listRef} aria-live="polite">
            {chat.map((m) =>
              m.type === 'system' ? (
                <div key={m.id} className="chat-msg chat-system">
                  {m.text}
                </div>
              ) : (
                <div
                  key={m.id}
                  className={`chat-msg ${m.senderId === me?.playerId ? 'chat-mine' : ''}`}
                >
                  <span className="chat-sender">{m.senderNickname}</span>
                  <span className="chat-text">{m.text}</span>
                </div>
              ),
            )}
            {chat.length === 0 && <div className="chat-empty">아직 메시지가 없습니다</div>}
          </div>
          <div className="chat-input-row">
            <input
              value={input}
              maxLength={MAX_CHAT_LENGTH}
              placeholder="메시지 입력..."
              aria-label="채팅 메시지"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit();
              }}
            />
            <button type="button" onClick={() => void submit()}>
              전송
            </button>
          </div>
        </>
      )}
    </div>
  );
}
