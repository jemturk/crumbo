import ConversationView from '@/components/ConversationView';
import { useConversation } from '@/hooks/use-conversation';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function ChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    friendId: string;
    incomingCall?: string;
    callType?: string;
    roomName?: string;
    friendName?: string;
    acceptCallImmediately?: string;
    callUUID?: string;
    declineCall?: string;
    /** Set when navigated here from a quick-call button on the Cookie Jar list. */
    autoStartCall?: string;
  }>();

  const conversation = useConversation({
    mode: 'kid',
    friendId: params.friendId,
    incomingCall: params.incomingCall,
    callType: params.callType,
    roomName: params.roomName,
    friendName: params.friendName,
    acceptCallImmediately: params.acceptCallImmediately,
    callUUID: params.callUUID,
    declineCall: params.declineCall,
    autoStartCall: params.autoStartCall,
  });

  return <ConversationView conversation={conversation} onBack={() => router.replace('/chat')} />;
}
