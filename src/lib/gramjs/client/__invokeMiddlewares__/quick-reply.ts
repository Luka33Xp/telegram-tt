import type TelegramClient from '../MockClient';
import type { MockTypes } from '../mockUtils/MockTypes';

import readStrings from '../../../../util/data/readStrings';
import { pause } from '../../../../util/schedulers';
import Api from '../../tl/api';
import createMockedDialog from '../mockUtils/createMockedDialog';
import createMockedMessage from '../mockUtils/createMockedMessage';
import createMockedTypeInputPeer from '../mockUtils/createMockedTypeInputPeer';
import createMockedUser from '../mockUtils/createMockedUser';
import getIdFromInputPeer from '../mockUtils/getIdFromInputPeer';

import fallbackStrings from '../../../../assets/localization/fallback.strings?raw';

// Demo scenario for the chat list quick reply: relative message dates, online contacts,
// working message sending with a scripted answer, and a local English language pack

type MockUserWithStatus = MockTypes['users'][number] & { isOnline?: boolean };

type AutoReply = {
  text: string;
  delayMs: number;
};

const SEQ = 1;
const DIALOGS_LATENCY_MS = 300;
const ONLINE_EXPIRES_SECONDS = 3600;
const READ_DELAY_MS = 900;
const TYPING_DELAY_MS = 1400;
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const DIALOG_FILTERS = [
  { id: 2, title: 'Personal', peerIds: ['102', '104', '105', '106'] },
  { id: 3, title: 'Work', peerIds: ['101', '103', '107'] },
];
// The seven basic name colors every account gets from the server
const PEER_COLORS = [0xD45246, 0xF68136, 0x6C61DF, 0x46BA43, 0x5CAFFA, 0x408ACF, 0xD95574];

const AUTO_REPLIES: Record<string, AutoReply> = {
  102: { text: 'Yay! Bring dessert 🍰❤️', delayMs: 3200 },
  103: { text: 'Perfect, see you there 🙌', delayMs: 2600 },
  106: { text: 'Perfect, talk then 🙌', delayMs: 2400 },
};

// Sending a message in the open chat makes someone else write a little later, so the demo can switch
// to another window and catch the notification
const FOLLOW_UPS: Record<string, { chatId: string; text: string; delayMs: number }> = {
  101: { chatId: '106', text: 'Hey! Are you free for a quick call later? 📞', delayMs: 10000 },
};
const sentFollowUps = new Set<string>();

// Strings from the legacy language packs that the demo screens show but `fallback.strings` lacks
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LEGACY_STRINGS: Record<string, string> = {
  MarkAllAsRead: 'Mark All as Read',
  WeekdayToday: 'Today',
  'Weekday.Today': 'Today',
  'Weekday.Yesterday': 'Yesterday',
  ...Object.fromEntries(WEEKDAYS.flatMap((day) => [
    [`Weekday.${day}`, day],
    [`Weekday.Short${day}`, day.slice(0, 3)],
  ])),
};

const normalizedData = new WeakSet<MockTypes>();
let pts = 1;
let langPackDifference: Api.LangPackDifference | undefined;

export default function<A, R>(mockClient: TelegramClient, request: Api.Request<A, R>) {
  const { mockData } = mockClient;
  normalizeMockData(mockData);

  if (request instanceof Api.updates.GetState) {
    return new Api.updates.State({
      pts, qts: 0, seq: SEQ, date: getNow(), unreadCount: 0,
    });
  }

  if (request instanceof Api.updates.GetDifference) {
    return new Api.updates.DifferenceEmpty({ date: getNow(), seq: SEQ });
  }

  if (request instanceof Api.users.GetFullUser) {
    const userId = request.id instanceof Api.InputUser ? request.id.userId.toString() : getSelfId(mockData);
    return new Api.users.UserFull({
      fullUser: new Api.UserFull({
        id: BigInt(userId),
        settings: new Api.PeerSettings({}),
        notifySettings: new Api.PeerNotifySettings({}),
        commonChatsCount: 0,
      }),
      chats: [],
      users: [createMockedUser(userId, mockData)],
    });
  }

  if (request instanceof Api.messages.SendMessage) {
    const chatId = getIdFromInputPeer(request.peer);
    const id = addMessage(mockData, chatId, { message: request.message, out: true });
    pts++;

    const autoReply = AUTO_REPLIES[chatId];
    if (autoReply) {
      scheduleAutoReply(mockClient, chatId, id, autoReply);
    }

    const followUp = FOLLOW_UPS[chatId];
    if (followUp && !sentFollowUps.has(chatId)) {
      sentFollowUps.add(chatId);
      setTimeout(() => deliverMessage(mockClient, followUp.chatId, followUp.text), followUp.delayMs);
    }

    return new Api.UpdateShortSentMessage({
      out: true,
      id,
      pts,
      ptsCount: 1,
      date: getNow(),
      entities: request.entities,
    });
  }

  if (request instanceof Api.messages.ReadHistory) {
    const chatId = getIdFromInputPeer(request.peer);
    const dialog = mockData.dialogs.active.find((d) => d.id === chatId);
    if (dialog) {
      // `maxId` of 0 reads the whole history
      dialog.readInboxMaxId = request.maxId || dialog.topMessage;
      dialog.unreadCount = mockData.messages[chatId]
        .filter((message) => !message.out && message.id > dialog.readInboxMaxId!).length;
    }
    pts++;

    return new Api.messages.AffectedMessages({ pts, ptsCount: 1 });
  }

  // Refreshes unread counters after reading
  if (request instanceof Api.messages.GetPeerDialogs) {
    const chatIds = request.peers
      .filter((peer): peer is Api.InputDialogPeer => peer instanceof Api.InputDialogPeer)
      .map(({ peer }) => getIdFromInputPeer(peer));

    return new Api.messages.PeerDialogs({
      dialogs: chatIds.map((id) => createMockedDialog(id, mockData)),
      messages: chatIds.map((id) => createMockedMessage(id, getDialog(mockData, id).topMessage!, mockData)),
      chats: [],
      users: chatIds.map((id) => createMockedUser(id, mockData)),
      state: new Api.updates.State({
        pts, qts: 0, seq: SEQ, date: getNow(), unreadCount: 0,
      }),
    });
  }

  // An empty config is enough for the app to finish its startup, which also loads notification settings
  if (request instanceof Api.help.GetAppConfig) {
    return new Api.help.AppConfig({ hash: 1, config: new Api.JsonObject({ value: [] }) });
  }

  // Notifications show the message text, as with an account's default settings
  if (request instanceof Api.account.GetNotifySettings) {
    return new Api.PeerNotifySettings({ showPreviews: true, silent: false, muteUntil: 0 });
  }

  if (request instanceof Api.messages.SetTyping || request instanceof Api.messages.SaveDraft) {
    return true;
  }

  // A server-like latency lets the folder chat lists subscribe before the chats arrive
  if (request instanceof Api.messages.GetDialogs) {
    return pause(DIALOGS_LATENCY_MS).then(() => 'pass' as const);
  }

  if (request instanceof Api.messages.GetDialogFilters) {
    return new Api.messages.DialogFilters({
      filters: [
        new Api.DialogFilterDefault(),
        ...DIALOG_FILTERS.map(({ id, title, peerIds }) => new Api.DialogFilter({
          id,
          title: new Api.TextWithEntities({ text: title, entities: [] }),
          pinnedPeers: [],
          includePeers: peerIds.map((peerId) => createMockedTypeInputPeer(peerId, mockData)),
          excludePeers: [],
        })),
      ],
    });
  }

  if (request instanceof Api.help.GetPeerColors) {
    return new Api.help.PeerColors({
      hash: 1,
      colors: PEER_COLORS.map((color, colorId) => new Api.help.PeerColorOption({
        colorId,
        colors: new Api.help.PeerColorSet({ colors: [color] }),
      })),
    });
  }

  if (request instanceof Api.help.GetPeerProfileColors) {
    return new Api.help.PeerColors({ hash: 1, colors: [] });
  }

  if (request instanceof Api.langpack.GetLanguage) {
    return buildLanguage();
  }

  if (request instanceof Api.langpack.GetLangPack) {
    langPackDifference ??= buildLangPackDifference();
    return langPackDifference;
  }

  return 'pass';
}

function normalizeMockData(mockData: MockTypes) {
  if (normalizedData.has(mockData) || !mockData.users.length) return;
  normalizedData.add(mockData);

  const now = getNow();

  mockData.users.forEach((user: MockUserWithStatus) => {
    if (!user.self) {
      user.status = user.isOnline
        ? new Api.UserStatusOnline({ expires: now + ONLINE_EXPIRES_SECONDS })
        : new Api.UserStatusRecently();
    }
    delete user.isOnline;
  });

  Object.values(mockData.messages).forEach((messages) => {
    messages.forEach((message) => {
      // Dates in the scenario are offsets from the moment the demo starts
      if (message.date !== undefined && message.date <= 0) {
        message.date = now + message.date;
      }
      message.entities ??= [];
    });
  });

  mockData.dialogs.active.forEach((dialog) => {
    const ids = mockData.messages[dialog.id].map(({ id }) => id).sort((a, b) => a - b);
    const unreadCount = dialog.unreadCount || 0;

    dialog.topMessage = ids[ids.length - 1];
    dialog.readInboxMaxId = ids[ids.length - 1 - unreadCount] || 0;
    dialog.readOutboxMaxId = dialog.topMessage;
  });
}

function scheduleAutoReply(mockClient: TelegramClient, chatId: string, sentMessageId: number, autoReply: AutoReply) {
  const userId = BigInt(chatId);

  setTimeout(() => {
    pts++;
    mockClient.fireUpdate(new Api.UpdateReadHistoryOutbox({
      peer: new Api.PeerUser({ userId }),
      maxId: sentMessageId,
      pts,
      ptsCount: 1,
    }));
  }, READ_DELAY_MS);

  setTimeout(() => {
    mockClient.fireUpdate(new Api.UpdateUserTyping({
      userId,
      action: new Api.SendMessageTypingAction(),
    }));
  }, TYPING_DELAY_MS);

  setTimeout(() => {
    mockClient.fireUpdate(new Api.UpdateUserTyping({
      userId,
      action: new Api.SendMessageCancelAction(),
    }));

    deliverMessage(mockClient, chatId, autoReply.text);
  }, TYPING_DELAY_MS + autoReply.delayMs);
}

function deliverMessage(mockClient: TelegramClient, chatId: string, text: string) {
  const id = addMessage(mockClient.mockData, chatId, { message: text });
  pts++;
  mockClient.fireUpdate(new Api.UpdateShortMessage({
    id,
    userId: BigInt(chatId),
    message: text,
    pts,
    ptsCount: 1,
    date: getNow(),
    entities: [],
  }));
}

function addMessage(mockData: MockTypes, chatId: string, message: { message: string; out?: true }) {
  const id = Math.max(...Object.values(mockData.messages).flat().map((m) => m.id)) + 1;
  mockData.messages[chatId].push({
    id, date: getNow(), entities: [], ...message,
  });

  const dialog = getDialog(mockData, chatId);
  dialog.topMessage = id;
  if (!message.out) {
    dialog.unreadCount = (dialog.unreadCount || 0) + 1;
  }

  return id;
}

function getDialog(mockData: MockTypes, chatId: string) {
  return mockData.dialogs.active.find((d) => d.id === chatId)!;
}

function buildLanguage() {
  return new Api.LangPackLanguage({
    official: true,
    name: 'English',
    nativeName: 'English',
    langCode: 'en',
    pluralCode: 'en',
    stringsCount: 0,
    translatedCount: 0,
    translationsUrl: 'https://translations.telegram.org/en/',
  });
}

function buildLangPackDifference() {
  const plurals: Record<string, Partial<Record<typeof PLURAL_SUFFIXES[number], string>>> = {};
  const strings: Api.TypeLangPackString[] = [];

  Object.entries({ ...LEGACY_STRINGS, ...readStrings(fallbackStrings) }).forEach(([rawKey, value]) => {
    const [key, suffix] = rawKey.split('_') as [string, typeof PLURAL_SUFFIXES[number] | undefined];
    if (suffix && PLURAL_SUFFIXES.includes(suffix)) {
      plurals[key] = { ...plurals[key], [suffix]: value };
      return;
    }

    strings.push(new Api.LangPackString({ key: rawKey, value }));
  });

  Object.entries(plurals).forEach(([key, forms]) => {
    strings.push(new Api.LangPackStringPluralized({
      key,
      zeroValue: forms.zero,
      oneValue: forms.one,
      twoValue: forms.two,
      fewValue: forms.few,
      manyValue: forms.many,
      otherValue: forms.other!,
    }));
  });

  return new Api.LangPackDifference({
    langCode: 'en', fromVersion: 0, version: 1, strings,
  });
}

function getSelfId(mockData: MockTypes) {
  return mockData.users.find((user) => user.self)!.id;
}

function getNow() {
  return Math.floor(Date.now() / 1000);
}
