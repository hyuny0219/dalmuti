import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const sendChat = useStore((s) => s.sendChat);
  const me = useStore((s) => s.me);
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (collapsed) {
      setUnread((n) => n + 1);
    } else {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      setUnread(0);
    }
    // chat 변경 시에만 반응해야 함
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, collapsed]);

  const submit = async () => {
    if (await sendChat(input)) setInput('');
  };

  return (
    <div className={`chat-panel ${collapsed ? 'chat-collapsed' : ''}`}>
      <button
        type="button"
        className="chat-toggle"
        onClick={() => setCollapsed((c) => !c)}
      >
        💬 채팅
        {collapsed && unread > 0 && <span className="chat-badge">{unread}</span>}
        <span className="chat-toggle-arrow">{collapsed ? '▲' : '▼'}</span>
      </button>
      {!collapsed && (
        <>
          <div className="chat-list" ref={listRef}>
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
              maxLength={200}
              placeholder="메시지 입력..."
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
