import ConversationView from '@/components/ConversationView';
import { useConversation } from '@/hooks/use-conversation';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function ParentChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    code: string;
    name?: string;
    isOwnKid?: string;
    avatarEmoji?: string;
    avatarUrl?: string;
    incomingCall?: string;
    callType?: string;
    roomName?: string;
    friendName?: string;
    acceptCallImmediately?: string;
    callUUID?: string;
    declineCall?: string;
    /** Set when navigated here from a quick-call button on the parent Chats list. */
    autoStartCall?: string;
  }>();

  const conversation = useConversation({
    mode: 'adult',
    otherCode: decodeURIComponent(params.code),
    otherName: params.name,
    otherAvatarEmoji: params.avatarEmoji || undefined,
    otherAvatarUrl: params.avatarUrl || undefined,
    isOwnKid: params.isOwnKid === '1',
    incomingCall: params.incomingCall,
    callType: params.callType,
    roomName: params.roomName,
    friendName: params.friendName,
    acceptCallImmediately: params.acceptCallImmediately,
    callUUID: params.callUUID,
    declineCall: params.declineCall,
    autoStartCall: params.autoStartCall,
  });

  return <ConversationView conversation={conversation} onBack={() => router.replace('/parent/chat')} />;
}
