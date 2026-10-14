import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat, ApiDraft, ApiMessage, ApiTypingStatus, ApiUser } from '../../../api/types';
import type { SharedSettings } from '../../../global/types';
import { MAIN_THREAD_ID } from '../../../api/types';

import { requestForcedReflow, requestMeasure, requestMutation } from '../../../lib/fasterdom/fasterdom';
import { getUserFirstOrLastName } from '../../../global/helpers';
import {
  selectCanAnimateInterface,
  selectChat,
  selectChatMessages,
  selectListedIds,
  selectUser,
} from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { selectDraft, selectThreadLocalStateParam } from '../../../global/selectors/threads';
import { IS_TOUCH_ENV } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { isUserId } from '../../../util/entities/ids';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useSendMessageAction from '../../../hooks/useSendMessageAction';

import GroupChatInfo from '../../common/GroupChatInfo';
import PrivateChatInfo from '../../common/PrivateChatInfo';
import Button from '../../ui/Button';
import Portal from '../../ui/Portal';
import QuickReplyMessage from './QuickReplyMessage';

import styles from './QuickReply.module.scss';

type OwnProps = {
  chatId: string;
  container: HTMLElement;
  isOpen: boolean;
  onCloseAnimationEnd: NoneToVoidFunction;
};

type StateProps = {
  chat?: ApiChat;
  user?: ApiUser;
  messagesById?: Record<number, ApiMessage>;
  hasHistory: boolean;
  draft?: ApiDraft;
  typingStatusByPeerId?: Record<string, ApiTypingStatus>;
  messageSendKeyCombo: SharedSettings['messageSendKeyCombo'];
  withInterfaceAnimations?: boolean;
};

const MAX_MESSAGES = 5;
const BOUNDS_MARGIN = 8;
const CARD_RADIUS = 16;
const OPEN_DURATION = 260;
const CLOSE_DURATION = 220;
const FADE_IN_DURATION = 160;
const FADE_OUT_DURATION = 120;
const ACTIONS_DELAY = 40;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
// iOS sheet curve: the card visibly grows out of the row instead of popping open in the first frames
const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
const ENTER_SCALE = 0.96;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const QuickReply = ({
  chatId,
  container,
  isOpen,
  chat,
  user,
  messagesById,
  hasHistory,
  draft,
  typingStatusByPeerId,
  messageSendKeyCombo,
  withInterfaceAnimations,
  onCloseAnimationEnd,
}: OwnProps & StateProps) => {
  const {
    sendMessage, saveDraft, clearDraft, markChatMessagesRead, openChat, loadViewportMessages, closeQuickReply,
  } = getActions();

  const lang = useLang();

  const scrimRef = useRef<HTMLDivElement>();
  const cardRef = useRef<HTMLDivElement>();
  const surfaceRef = useRef<HTMLDivElement>();
  const actionsRef = useRef<HTMLDivElement>();
  const inputRef = useRef<HTMLTextAreaElement>();
  const isInstantCloseRef = useRef(false);

  const initialText = draft?.text?.text || '';
  const [text, setText] = useState(initialText);
  const persistedTextRef = useRef(initialText);
  const boundsRef = useRef<DOMRect>();

  // Messages that arrive after opening slide in, the ones already there are revealed by the card itself
  const lastIdOnOpenRef = useRef<number>();

  const sendMessageAction = useSendMessageAction(chatId, MAIN_THREAD_ID);

  const messages = useMemo(() => (messagesById ? selectLastMessages(messagesById, MAX_MESSAGES) : []), [messagesById]);
  const lastMessage = messages[messages.length - 1];
  const lastIncomingId = lastMessage && !lastMessage.isOutgoing ? lastMessage.id : undefined;
  lastIdOnOpenRef.current ??= lastMessage?.id ?? 0;

  // Once the user has replied, the card is a live conversation, so new messages are read as they arrive
  const hasRepliedRef = useRef(false);
  useEffect(() => {
    if (isOpen && hasRepliedRef.current && lastIncomingId) {
      markChatMessagesRead({ id: chatId });
    }
  }, [chatId, isOpen, lastIncomingId]);

  useEffect(() => {
    if (!hasHistory) {
      loadViewportMessages({ chatId, threadId: MAIN_THREAD_ID });
    }
  }, [chatId, hasHistory]);

  const persistDraft = useLastCallback(() => {
    const value = inputRef.current?.value ?? text;
    if (value === persistedTextRef.current) return;

    if (value.trim()) {
      saveDraft({ chatId, threadId: MAIN_THREAD_ID, text: { text: value } });
    } else {
      clearDraft({ chatId, threadId: MAIN_THREAD_ID });
    }
    persistedTextRef.current = value;
  });

  const handleClose = useLastCallback(() => {
    closeQuickReply();
  });

  const handleOpenChat = useLastCallback(() => {
    persistDraft();
    openChat({ id: chatId, shouldReplaceHistory: true });
    handleClose();
  });

  const handleSend = useLastCallback(() => {
    // The field is read directly, as a fast Enter can land before the state catches up with the last keystroke
    const messageText = inputRef.current!.value.trim();
    if (!messageText) return;

    sendMessage({
      messageList: { chatId, threadId: MAIN_THREAD_ID, type: 'thread' },
      text: messageText,
    });
    clearDraft({ chatId, threadId: MAIN_THREAD_ID, isLocalOnly: true });
    // Replying means the conversation has been read, while only peeking at it does not
    markChatMessagesRead({ id: chatId });
    hasRepliedRef.current = true;

    // The state may not have caught up with the field yet, in which case resetting it alone would keep the text
    const input = inputRef.current!;
    setText('');
    persistedTextRef.current = '';
    requestMutation(() => {
      input.value = '';
    });
    resizeInput();
    input.focus();
  });

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = e.currentTarget;
    setText(value);
    resizeInput();

    if (value.trim()) {
      sendMessageAction({ type: 'typing' });
    }
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || IS_TOUCH_ENV) return;

    const isSubmitModifierPressed = e.ctrlKey || e.metaKey;
    if (messageSendKeyCombo === 'ctrl-enter' && !isSubmitModifierPressed) return;

    e.preventDefault();
    handleSend();
  });

  function resizeInput() {
    const input = inputRef.current;
    if (!input) return;

    requestMutation(() => {
      input.style.height = '0';
      requestForcedReflow(() => {
        const newHeight = input.scrollHeight;
        return () => {
          input.style.height = `${newHeight}px`;
        };
      });
    });
  }

  // Keyboard actions close instantly, as an animation would only hold them up
  const handleEscape = useLastCallback(() => {
    isInstantCloseRef.current = true;
    handleClose();
  });

  useEffect(() => (isOpen ? captureEscKeyListener(handleEscape) : undefined), [isOpen, handleEscape]);

  // Any press outside the card closes it. The scrim swallows presses on the chat list
  // so they do not open another chat on the way.
  useEffect(() => {
    if (!isOpen) return undefined;

    function handlePointerDown(e: PointerEvent) {
      if (cardRef.current?.contains(e.target as Node)) return;
      handleClose();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isOpen, handleClose]);

  const animateOpen = useLastCallback(() => {
    requestMeasure(() => {
      const card = cardRef.current;
      const surface = surfaceRef.current;
      const scrim = scrimRef.current;
      if (!card || !surface || !scrim) return;

      const bounds = container.getBoundingClientRect();
      // Opened from a notification, the chat may not be on screen, then the card drops in at the top of the list
      const anchorRect = findVisibleRowRect(container, chatId, bounds);
      const maxHeight = bounds.height - BOUNDS_MARGIN * 2;

      boundsRef.current = bounds;

      requestMutation(() => {
        Object.assign(scrim.style, {
          top: `${bounds.top}px`,
          left: `${bounds.left}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        });
        Object.assign(card.style, {
          left: `${anchorRect ? anchorRect.left : bounds.left + BOUNDS_MARGIN}px`,
          width: `${anchorRect ? anchorRect.width : bounds.width - BOUNDS_MARGIN * 2}px`,
          maxHeight: `${maxHeight}px`,
        });

        // The height depends on the width set above
        requestForcedReflow(() => {
          const height = card.offsetHeight;
          const anchorTop = anchorRect?.top ?? bounds.top + BOUNDS_MARGIN;

          // Grow down from the row when there is room, otherwise sit on the bottom edge and grow upwards
          const fitsBelow = anchorTop + height <= bounds.bottom - BOUNDS_MARGIN;
          const top = fitsBelow
            ? Math.max(anchorTop, bounds.top + BOUNDS_MARGIN)
            : bounds.bottom - BOUNDS_MARGIN - height;

          return () => {
            if (fitsBelow) {
              card.style.top = `${top}px`;
            } else {
              card.style.bottom = `${window.innerHeight - bounds.bottom + BOUNDS_MARGIN}px`;
            }
            cancelAnimations(surface, scrim, actionsRef.current);
            isInstantCloseRef.current = false;
            card.classList.remove(styles.closing);
            scrim.classList.remove(styles.closing);
            card.classList.add(styles.ready);
            scrim.classList.add(styles.ready);

            resizeInput();
            requestMeasure(() => {
              const input = inputRef.current!;
              input.focus({ preventScroll: true });
              input.setSelectionRange(input.value.length, input.value.length);
            });

            if (!withInterfaceAnimations) return;

            scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_DURATION, easing: EASE_OUT });

            // Reduced motion keeps the cue that something appeared, without the movement
            if (window.matchMedia(REDUCED_MOTION_QUERY).matches) {
              surface.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_IN_DURATION, easing: EASE_OUT });
              return;
            }

            if (!anchorRect) {
              surface.animate([
                { opacity: 0, transform: `scale(${ENTER_SCALE})` },
                { opacity: 1, transform: 'scale(1)' },
              ], { duration: OPEN_DURATION, easing: EASE_OUT });
              return;
            }

            // The header strip starts exactly over the row and the rest of the card unfolds from it
            surface.animate([
              {
                transform: `translateY(${anchorRect.top - top}px)`,
                clipPath: buildStripClip(height, anchorRect.height),
              },
              { transform: 'translateY(0)', clipPath: buildFullClip() },
            ], { duration: OPEN_DURATION, easing: EASE_DRAWER });

            actionsRef.current?.animate([
              { opacity: 0, transform: 'translateY(-0.5rem)' },
              { opacity: 1, transform: 'translateY(0)' },
            ], {
              duration: OPEN_DURATION, delay: ACTIONS_DELAY, easing: EASE_OUT, fill: 'backwards',
            });
          };
        });
      });
    });
  });

  const animateClose = useLastCallback(() => {
    const card = cardRef.current;
    const surface = surfaceRef.current;
    const scrim = scrimRef.current;
    if (!card || !surface || !scrim || !withInterfaceAnimations || isInstantCloseRef.current) {
      onCloseAnimationEnd();
      return;
    }

    requestMeasure(() => {
      const cardRect = card.getBoundingClientRect();
      const bounds = boundsRef.current || container.getBoundingClientRect();
      // The row may have moved, e.g. to the top after a reply, so the card folds into its current place
      const anchorRect = findVisibleRowRect(container, chatId, bounds);
      // Start from what is on screen, so closing mid-unfold reverses instead of jumping
      const surfaceStyle = getComputedStyle(surface);
      const fromTransform = surfaceStyle.transform === 'none' ? 'translateY(0)' : surfaceStyle.transform;
      const fromClipPath = surfaceStyle.clipPath === 'none' ? buildFullClip() : surfaceStyle.clipPath;
      const fromScrimOpacity = getComputedStyle(scrim).opacity;

      requestMutation(() => {
        cancelAnimations(surface, scrim, actionsRef.current);
        // Nothing should wait for the fold to finish
        card.classList.add(styles.closing);
        scrim.classList.add(styles.closing);

        let animation: Animation;

        if (anchorRect && !window.matchMedia(REDUCED_MOTION_QUERY).matches) {
          const offset = anchorRect.top - cardRect.top;
          animation = surface.animate([
            { transform: fromTransform, clipPath: fromClipPath },
            {
              transform: `translateY(${offset}px)`,
              clipPath: buildStripClip(cardRect.height, anchorRect.height),
            },
          ], {
            duration: CLOSE_DURATION,
            // A long flight is a move on screen, a fold in place is an exit
            easing: Math.abs(offset) > anchorRect.height ? EASE_IN_OUT : EASE_OUT,
            fill: 'forwards',
          });
          actionsRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: FADE_OUT_DURATION, easing: EASE_OUT, fill: 'forwards',
          });
        } else {
          animation = surface.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: FADE_OUT_DURATION, easing: EASE_OUT, fill: 'forwards',
          });
        }

        scrim.animate([{ opacity: fromScrimOpacity }, { opacity: 0 }], {
          duration: CLOSE_DURATION, easing: EASE_OUT, fill: 'forwards',
        });

        animation.onfinish = onCloseAnimationEnd;
      });
    });
  });

  useLayoutEffect(() => {
    if (isOpen) {
      animateOpen();
    } else {
      persistDraft();
      animateClose();
    }
  }, [isOpen, animateOpen, animateClose, persistDraft]);

  if (!chat) return undefined;

  const isPrivate = isUserId(chatId);
  const isSelf = Boolean(user?.isSelf);
  const placeholder = isSelf || !isPrivate
    ? lang('ComposerPlaceholder')
    : lang('QuickReplyPlaceholder', { name: getUserFirstOrLastName(user) || chat.title });
  const canSend = Boolean(text.trim());

  return (
    <Portal>
      <div>
        <div ref={scrimRef} className={styles.scrim} />
        <div
          ref={cardRef}
          className={styles.card}
          role="dialog"
          aria-label={lang('QuickReply')}
        >
          <div ref={surfaceRef} className={styles.surface}>
            <div className={styles.header}>
              <div className={styles.chatInfo}>
                {isPrivate ? (
                  <PrivateChatInfo
                    userId={chatId}
                    typingStatusByPeerId={typingStatusByPeerId}
                    avatarSize="large"
                    withUpdatingStatus
                    withMediaViewer={false}
                    withStory={false}
                    withFullInfo={false}
                    noRtl
                  />
                ) : (
                  <GroupChatInfo
                    chatId={chatId}
                    typingStatusByPeerId={typingStatusByPeerId}
                    avatarSize="large"
                    withUpdatingStatus
                    withMediaViewer={false}
                    withStory={false}
                    withFullInfo={false}
                    noRtl
                  />
                )}
              </div>
              <div ref={actionsRef} className={styles.headerActions}>
                <Button
                  round
                  color="translucent"
                  size="smaller"
                  iconName="arrow-right"
                  ariaLabel={lang('QuickReplyOpenChat')}
                  onClick={handleOpenChat}
                />
                <Button
                  round
                  color="translucent"
                  size="smaller"
                  iconName="close"
                  ariaLabel={lang('Close')}
                  onClick={handleClose}
                />
              </div>
            </div>
            <div className={styles.body}>
              <div className={styles.messages}>
                <div className={styles.messagesInner}>
                  {messages.map((message, i) => (
                    <QuickReplyMessage
                      key={message.previousLocalId ?? message.id}
                      message={message}
                      withSenderName={!isPrivate && !message.isOutgoing
                        && messages[i - 1]?.senderId !== message.senderId}
                      shouldAppear={withInterfaceAnimations
                        && (message.previousLocalId ?? message.id) > lastIdOnOpenRef.current!}
                    />
                  ))}
                </div>
              </div>
              <div className={styles.composer}>
                <textarea
                  ref={inputRef}
                  className={styles.input}
                  value={text}
                  rows={1}
                  dir="auto"
                  placeholder={placeholder}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                />
                <Button
                  round
                  color="primary"
                  size="smaller"
                  className={buildClassName(styles.sendButton, !canSend && styles.sendButtonHidden)}
                  iconName="send"
                  ariaLabel={lang('Send')}
                  tabIndex={canSend ? undefined : -1}
                  onClick={handleSend}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
};

function selectLastMessages(messagesById: Record<number, ApiMessage>, limit: number) {
  const result: ApiMessage[] = [];

  // A single pass keeps this cheap for chats with a long loaded history
  Object.values(messagesById).forEach((message) => {
    if (result.length < limit) {
      result.push(message);
      if (result.length === limit) result.sort(compareById);
      return;
    }

    if (message.id <= result[0].id) return;

    result[0] = message;
    result.sort(compareById);
  });

  return result.length < limit ? result.sort(compareById) : result;
}

function compareById(a: ApiMessage, b: ApiMessage) {
  return a.id - b.id;
}

// Every chat row contains the chat's avatar, which carries its peer id
function findVisibleRowRect(container: HTMLElement, chatId: string, bounds: DOMRect) {
  const row = container.querySelector(`[data-peer-id="${chatId}"]`)?.closest('.Chat');
  const rect = row?.getBoundingClientRect();
  if (!rect?.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return undefined;

  return rect;
}

function cancelAnimations(...elements: (HTMLElement | undefined)[]) {
  elements.forEach((element) => element?.getAnimations().forEach((animation) => animation.cancel()));
}

function buildStripClip(cardHeight: number, stripHeight: number) {
  return `inset(0 0 ${Math.max(cardHeight - stripHeight, 0)}px 0 round ${CARD_RADIUS}px)`;
}

function buildFullClip() {
  return `inset(0 0 0 0 round ${CARD_RADIUS}px)`;
}

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    return {
      chat: selectChat(global, chatId),
      user: selectUser(global, chatId),
      messagesById: selectChatMessages(global, chatId),
      hasHistory: Boolean(selectListedIds(global, chatId, MAIN_THREAD_ID)?.length),
      draft: selectDraft(global, chatId, MAIN_THREAD_ID),
      typingStatusByPeerId: selectThreadLocalStateParam(global, chatId, MAIN_THREAD_ID, 'typingStatusByPeerId'),
      messageSendKeyCombo: selectSharedSettings(global).messageSendKeyCombo,
      withInterfaceAnimations: selectCanAnimateInterface(global),
    };
  },
)(QuickReply));
