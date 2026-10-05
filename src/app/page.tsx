'use client';

import { useEffect, useRef, useState } from 'react';
import { Toast } from '@/components/ui';
import ChatHeader from '@/components/chat/ChatHeader';
import EventBar from '@/components/chat/EventBar';
import MessageList from '@/components/chat/MessageList';
import Composer from '@/components/chat/Composer';
import StickerPanel from '@/components/chat/StickerPanel';
import PhotoModal from '@/components/chat/PhotoModal';
import DeleteModal from '@/components/chat/DeleteModal';
import { useChatState } from '@/components/chat/use-chat-state';
import { useChatStream } from '@/components/chat/use-chat-stream';
import { useChatTts } from '@/components/chat/use-chat-tts';
import { usePhoto } from '@/components/chat/use-photo';
import { useDeleteFlow } from '@/components/chat/use-delete-flow';
import { useEventBar } from '@/components/chat/use-event-bar';
import { useSticker } from '@/components/chat/use-sticker';
import { useOnboarding } from '@/components/chat/use-onboarding';

export default function ChatPage() {
  const [input, setInput] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const visitAtRef = useRef<number>(Date.now()); // "你这次进来"的时间（用于"她等了你多久"）

  const { state, onboard, setOnboard, loadState, setSceneMode } = useChatState(setToast);
  const {
    messages,
    setMessages,
    sending,
    typing,
    busyNote,
    recalling,
    loadErr,
    listRef,
    loadMessages,
    send,
    regenerate,
    withdraw,
  } = useChatStream({ state, loadState, setToast, input, setInput });
  const { playingId, playTts } = useChatTts(setToast);
  const { photoOpen, setPhotoOpen, photoLoading, photoSrc, photoCaption, openPhoto } = usePhoto();
  const { delTarget, setDelTarget, delCascade, setDelCascade, deleting, delCancelRef, doDelete } = useDeleteFlow({
    setMessages,
    loadState,
    setToast,
  });
  const {
    evBusy,
    evCustomOpen,
    evMin,
    evImmediateOpen,
    evHours,
    setEvMin,
    setEvHours,
    setEvImmediateOpen,
    setEvCustomOpen,
    eventAction,
  } = useEventBar({ state, loadMessages, loadState, setToast });
  const { stickerOpen, setStickerOpen, stickerPanelRef, stickerBtnRef, insertSticker } = useSticker(setInput);
  const { nameDraft, setNameDraft, saveOnboard } = useOnboarding({ setOnboard, loadState, setToast });

  /* 记录"你这次进来"的时间（用于顶部"她等了你 X 小时"） */
  useEffect(() => {
    visitAtRef.current = Date.now();
    try {
      window.localStorage.setItem('lastVisitAt', String(visitAtRef.current));
    } catch {
      /* ignore */
    }
  }, []);

  const her = state?.persona?.agent_name || '她';
  const mood = state?.relationship?.mood || '平静';
  const stageName = state?.relationship?.stageName || '初识';
  const intimacy = Number(state?.relationship?.intimacy || 0);
  const scene = state?.relationship?.scene === 'offline' ? 'offline' : 'online';
  const sceneMode = (state?.relationship?.sceneMode || 'auto') as 'auto' | 'online' | 'offline';

  // 最后一条消息（仅它显示重新生成/撤回按钮）
  const lastMsg = messages.length ? messages[messages.length - 1] : null;
  const lastMsgId = lastMsg?.id || 0;

  // "她等了你 X 小时"：她最后一条（你还没回的）消息，距今 ≥ 1 小时
  const waitHint = (() => {
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.streaming) return null;
    const ts = new Date(lastMsg.created_at).getTime();
    if (!isFinite(ts)) return null;
    const ms = visitAtRef.current - ts;
    if (ms < 3600_000) return null;
    const h = Math.floor(ms / 3600_000);
    return h >= 24 ? `她等了你 ${Math.floor(h / 24)} 天` : `她等了你 ${h} 小时`;
  })();

  return (
    <div className="flex h-screen flex-col">
      {/* 顶部状态 */}
      <ChatHeader
        her={her}
        mood={mood}
        stageName={stageName}
        intimacy={intimacy}
        scene={scene}
        sceneMode={sceneMode}
        state={state}
        onOpenPhoto={openPhoto}
        onSetSceneMode={setSceneMode}
      >
        <EventBar
          ongoingEvent={state?.life?.ongoingEvent}
          evBusy={evBusy}
          evImmediateOpen={evImmediateOpen}
          evCustomOpen={evCustomOpen}
          evMin={evMin}
          evHours={evHours}
          setEvMin={setEvMin}
          setEvHours={setEvHours}
          setEvImmediateOpen={setEvImmediateOpen}
          setEvCustomOpen={setEvCustomOpen}
          onEventAction={eventAction}
        />
        {recalling ? (
          <div className="mt-2 text-[11px] acc animate-pulse-soft">她在回味刚才的对话…（更新记忆、性格信号、关系数值）</div>
        ) : null}
      </ChatHeader>

      {/* 消息列表 */}
      <MessageList
        listRef={listRef}
        loadErr={loadErr}
        messages={messages}
        onboard={onboard}
        sending={sending}
        typing={typing}
        busyNote={busyNote}
        waitHint={waitHint}
        lastMsgId={lastMsgId}
        playingId={playingId}
        ttsEnabled={state?.ttsEnabled}
        stickers={state?.stickers}
        setInput={setInput}
        send={send}
        onRequestDelete={(m) => {
          setDelTarget(m);
          setDelCascade(false);
        }}
        onPlayTts={playTts}
        onRegenerate={regenerate}
        onWithdraw={withdraw}
        nameDraft={nameDraft}
        setNameDraft={setNameDraft}
        onSaveOnboard={saveOnboard}
        onSkipOnboard={() => setOnboard(false)}
      />

      {/* 输入框 */}
      <div className="sticky bottom-0 border-t line surf px-4 py-3 pb-20 backdrop-blur md:px-8 md:pb-3">
        <StickerPanel
          open={stickerOpen}
          stickers={state?.stickers}
          onInsert={insertSticker}
          onClose={() => setStickerOpen(false)}
          panelRef={stickerPanelRef}
        />
        <Composer
          input={input}
          setInput={setInput}
          sending={sending}
          onSend={() => send()}
          stickerOpen={stickerOpen}
          onToggleSticker={() => setStickerOpen((v) => !v)}
          stickerBtnRef={stickerBtnRef}
        />
      </div>

      <DeleteModal
        target={delTarget}
        cascade={delCascade}
        setCascade={setDelCascade}
        deleting={deleting}
        stickers={state?.stickers}
        cancelRef={delCancelRef}
        onCancel={() => setDelTarget(null)}
        onDelete={doDelete}
      />

      <PhotoModal
        open={photoOpen}
        loading={photoLoading}
        src={photoSrc}
        caption={photoCaption}
        onClose={() => setPhotoOpen(false)}
      />

      {toast ? <Toast text={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}