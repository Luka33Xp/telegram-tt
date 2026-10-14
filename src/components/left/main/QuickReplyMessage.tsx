import { memo } from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiMessage, ApiMessageOutgoingStatus, ApiPeer } from '../../../api/types';
import { MAIN_THREAD_ID } from '../../../api/types';

import { getPeerColorKey, isActionMessage } from '../../../global/helpers';
import { getPeerTitle } from '../../../global/helpers/peers';
import { selectOutgoingStatus, selectSender } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { formatTime } from '../../../util/dates/oldDateFormat';

import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';
import { getPeerColorClass } from '../../../hooks/usePeerColor';

import MessageOutgoingStatus from '../../common/MessageOutgoingStatus';
import MessageSummary from '../../common/MessageSummary';

import styles from './QuickReply.module.scss';

type OwnProps = {
  message: ApiMessage;
  withSenderName?: boolean;
  shouldAppear?: boolean;
};

type StateProps = {
  sender?: ApiPeer;
  outgoingStatus?: ApiMessageOutgoingStatus;
};

const SUMMARY_LENGTH = 1000;

const QuickReplyMessage = ({
  message,
  withSenderName,
  shouldAppear,
  sender,
  outgoingStatus,
}: OwnProps & StateProps) => {
  const lang = useLang();
  const oldLang = useOldLang();

  if (isActionMessage(message)) {
    return (
      <div className={buildClassName(styles.serviceMessage, shouldAppear && styles.appear)}>
        <MessageSummary message={message} truncateLength={SUMMARY_LENGTH} />
      </div>
    );
  }

  const { isOutgoing } = message;

  return (
    <div
      className={buildClassName(
        styles.message,
        isOutgoing ? styles.outgoing : styles.incoming,
        shouldAppear && styles.appear,
      )}
    >
      {withSenderName && sender && (
        <div className={buildClassName(styles.senderName, getPeerColorClass(getPeerColorKey(sender, true)!))}>
          {getPeerTitle(lang, sender)}
        </div>
      )}
      <MessageSummary message={message} truncateLength={SUMMARY_LENGTH} />
      <span className={styles.meta}>
        {formatTime(oldLang, message.date * 1000)}
        {outgoingStatus && <MessageOutgoingStatus status={outgoingStatus} />}
      </span>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { message, withSenderName }): Complete<StateProps> => {
    return {
      sender: withSenderName ? selectSender(global, message) : undefined,
      outgoingStatus: message.isOutgoing
        ? selectOutgoingStatus(global, message.chatId, MAIN_THREAD_ID, message.id, 'thread')
        : undefined,
    };
  },
)(QuickReplyMessage));
