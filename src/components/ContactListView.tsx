import AdultAvatar from '@/components/AdultAvatar';
import { ContactListRow } from '@/hooks/use-contact-list';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { FlatList, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ContactListHeaderAction {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}

interface ContactListViewProps {
  headerAvatar: React.ReactNode;
  onHeaderAvatarPress?: () => void;
  headerSubtitle?: string;
  headerTitle: string;
  headerActions: ContactListHeaderAction[];
  rows: ContactListRow[];
  emptyEmoji: string;
  emptyTitle: string;
  emptySubtitle: string;
  /** Mode-specific modals (avatar pickers, settings, QR dialogs) — rendered as-is after the list. */
  children?: React.ReactNode;
}

// Shared presentational shell for chat/index.tsx (Cookie Jar) and parent/chat/index.tsx (Chats)
// — identical header/list/empty-state layout for both; see use-contact-list.ts for how `rows`
// differs (parental locks + pending-pairing gate on the kid side, none on the adult side) and
// each route file for what it passes as headerActions/children (QR pairing stays adult-only).
export default function ContactListView({
  headerAvatar,
  onHeaderAvatarPress,
  headerSubtitle,
  headerTitle,
  headerActions,
  rows,
  emptyEmoji,
  emptyTitle,
  emptySubtitle,
  children,
}: ContactListViewProps) {
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  const renderRow = ({ item }: { item: ContactListRow }) => (
    <TouchableOpacity
      style={[styles.friendCard, { backgroundColor: colors.cardBg, borderColor: colors.border, padding: s(16), shadowColor: colors.textSecondary }]}
      onPress={item.onPress}
    >
      {item.isAdultAvatar ? (
        <View style={{ marginRight: s(16) }}>
          <AdultAvatar uri={item.avatarUrl} emoji={item.avatarEmoji} size={s(52)} />
        </View>
      ) : (
        <View style={[styles.avatarContainer, { backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderColor: colors.borderStrong, width: s(52), height: s(52), borderRadius: s(26), marginRight: s(16) }]}>
          <Text style={[styles.avatarText, { fontSize: s(28) }]}>{item.avatarEmoji}</Text>
        </View>
      )}

      <View style={styles.friendInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(6) }}>
          <Text style={[styles.friendName, { fontSize: s(18), color: colors.text }]}>{item.name}</Text>
          {item.badge && (
            <View style={[styles.pendingBadgeSmall, { paddingHorizontal: s(6), paddingVertical: s(2) }]}>
              <Text style={[styles.pendingBadgeTextSmall, { fontSize: s(10) }]}>{item.badge}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.lastMessage, { fontSize: s(14), color: colors.textSecondary }]} numberOfLines={1}>
          {item.subtitle}
        </Text>
      </View>

      {item.showCallButtons && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(6), marginRight: s(8) }}>
          {!item.hideVoiceCall && (
            <TouchableOpacity
              style={[styles.quickCallBtn, { width: s(32), height: s(32), borderRadius: s(16), backgroundColor: isDark ? colors.inputBg : '#FFFDF5', borderColor: colors.borderStrong }]}
              onPress={(e) => { e.stopPropagation(); item.onQuickCall(false); }}
            >
              <Ionicons name="call" size={s(15)} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
          {!item.hideVideoCall && (
            <TouchableOpacity
              style={[styles.quickCallBtn, { width: s(32), height: s(32), borderRadius: s(16), backgroundColor: isDark ? colors.inputBg : '#FFFDF5', borderColor: colors.borderStrong }]}
              onPress={(e) => { e.stopPropagation(); item.onQuickCall(true); }}
            >
              <Ionicons name="videocam" size={s(15)} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      )}
      <Ionicons name="chevron-forward" size={s(20)} color={colors.textSecondary} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { backgroundColor: colors.cardBg, borderColor: colors.border, paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(44)) : s(14), paddingHorizontal: s(20), paddingVertical: s(14), borderBottomWidth: 2 }]}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={onHeaderAvatarPress} disabled={!onHeaderAvatarPress}>
            {headerAvatar}
          </TouchableOpacity>
          <View>
            {headerSubtitle && (
              <Text style={[styles.headerSub, { fontSize: s(12), color: colors.textSecondary }]}>{headerSubtitle}</Text>
            )}
            <Text style={[styles.headerTitle, { fontSize: s(20), color: colors.text }]}>{headerTitle}</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8) }}>
          {headerActions.map(action => (
            <TouchableOpacity key={action.key} style={styles.headerActionButton} onPress={action.onPress}>
              <Ionicons name={action.icon} size={s(24)} color={colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {rows.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyEmoji, { fontSize: s(72) }]}>{emptyEmoji}</Text>
          <Text style={[styles.emptyText, { fontSize: s(22), color: colors.text }]}>{emptyTitle}</Text>
          <Text style={[styles.emptySubtext, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
            {emptySubtitle}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.key}
          renderItem={renderRow}
          contentContainerStyle={[styles.listContent, { padding: s(16), gap: s(12) }]}
        />
      )}

      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFDF3',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 2,
    borderColor: '#FFF5D1',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'android' ? 44 : 14,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerSub: {
    fontSize: 12,
    color: '#8D6E63',
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
    marginTop: -2,
  },
  headerActionButton: {
    padding: 6,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  friendCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#FFF5D1',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  avatarContainer: {
    backgroundColor: '#FFFDF0',
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
    borderWidth: 2,
    borderColor: '#FFEFC0',
  },
  avatarText: {
    fontSize: 28,
  },
  quickCallBtn: {
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  friendInfo: {
    flex: 1,
  },
  friendName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#4E342E',
    marginBottom: 4,
  },
  lastMessage: {
    fontSize: 14,
    color: '#8D6E63',
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyEmoji: {
    fontSize: 72,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#4E342E',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#8D6E63',
    textAlign: 'center',
    lineHeight: 20,
    fontWeight: '600',
  },
  pendingBadgeSmall: {
    backgroundColor: '#FFE0B2',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pendingBadgeTextSmall: {
    fontSize: 10,
    color: '#E65100',
    fontWeight: '800',
  },
});
