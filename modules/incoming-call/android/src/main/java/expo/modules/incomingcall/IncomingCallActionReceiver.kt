package expo.modules.incomingcall

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationManagerCompat
import io.wazo.callkeep.VoiceConnectionService

const val ACTION_ANSWER_CALL = "expo.modules.incomingcall.ACTION_ANSWER_CALL"
const val ACTION_DECLINE_CALL = "expo.modules.incomingcall.ACTION_DECLINE_CALL"
// Fired by the AlarmManager backstop scheduled in IncomingCallModule.scheduleRingTimeout —
// see that function's doc for why this exists (killed-app / dropped-CANCEL-push ring-forever).
const val ACTION_RING_TIMEOUT = "expo.modules.incomingcall.ACTION_RING_TIMEOUT"
const val EXTRA_CALL_UUID = "callUUID"
const val EXTRA_FRIEND_ID = "friendId"
const val EXTRA_ROOM_NAME = "roomName"
const val EXTRA_IS_VIDEO = "isVideo"
const val EXTRA_CALLER_NAME = "callerName"

private const val SCHEME = "crumbo" // app.json "scheme" — must stay in sync.
private const val HOST = "chat" // expo-router route: app/chat/[friendId].tsx

/**
 * Handles the Answer/Decline actions on the incoming-call notification (posted by
 * IncomingCallModule.showNotification). These used to be plain activity launches — tapping
 * either button just opened the app with a query param (acceptCallImmediately/declineCall) and
 * left it up to JS/expo-router to notice and resolve the call. In practice that hand-off wasn't
 * reliable when the app was merely backgrounded (not killed): the user would tap Accept/Decline
 * on the notification and land back on Crumbo's own ringing screen, needing to press
 * Accept/Decline a second time there.
 *
 * This resolves the call directly against Telecom the instant the button is tapped — via
 * react-native-callkeep's own static connection registry, independent of whether the JS bridge
 * is alive/fast enough to react — and separately notifies JS through IncomingCallModule's own
 * event. That's deliberately NOT RNCallKeep's generic answerCall/endCall events: those have
 * their own unrelated semantics (see callkeep.ts's isUserInitiated handling, which intentionally
 * ignores a plain Telecom disconnect while a call is still ringing) that don't map cleanly onto
 * "the user just tapped Decline on our notification."
 *
 * Still launches the app afterward, same as before, so the user sees the live/ended call screen
 * and so the existing deep-link based accept/decline handling in use-call.ts keeps working as a
 * fallback if this event somehow doesn't reach JS in time (e.g. a very cold start).
 *
 * Also handles ACTION_RING_TIMEOUT, fired by the AlarmManager backstop IncomingCallModule
 * schedules alongside every notification — unlike Answer/Decline this isn't a user action, so
 * it only silences the ring/Telecom state and notifies JS if alive; it deliberately does not
 * force-launch the app (see the branch below).
 */
class IncomingCallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callUUID = intent.getStringExtra(EXTRA_CALL_UUID) ?: return
    val friendId = intent.getStringExtra(EXTRA_FRIEND_ID) ?: ""
    val roomName = intent.getStringExtra(EXTRA_ROOM_NAME) ?: ""
    val isVideo = intent.getBooleanExtra(EXTRA_IS_VIDEO, false)
    val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: ""
    val accept = intent.action == ACTION_ANSWER_CALL
    val isRingTimeout = intent.action == ACTION_RING_TIMEOUT

    NotificationManagerCompat.from(context).cancel(callUUID.hashCode())
    // Whichever of answer/decline/timeout fires first wins — defuse the other two so they
    // can't also fire later (the notification tap/buttons and the alarm race independently).
    IncomingCallModule.cancelRingTimeout(context, callUUID)

    try {
      val connection = VoiceConnectionService.getConnection(callUUID)
      if (accept) connection?.onAnswer() else connection?.onReject()
    } catch (e: Throwable) {
      // Best-effort: react-native-callkeep may not have this connection for some reason (e.g.
      // it already ended). The app-level accept/decline launched below still runs regardless.
    }

    if (isRingTimeout) {
      // Nobody answered or declined in time. Unlike Answer/Decline this wasn't a user action,
      // so don't force the app to the foreground over whatever the user is currently doing —
      // just silence the ring (done above) and best-effort tell JS if it's still alive, so an
      // already-open chat screen can log the miss and let the caller know. If the process is
      // fully dead, the caller's own symmetric ring-timeout (use-call.ts) still resolves their
      // side; the notification no longer rings forever either way, which is the actual bug.
      IncomingCallModule.notifyMissed(callUUID, friendId, roomName, isVideo, callerName)
      return
    }

    if (accept) {
      IncomingCallModule.notifyAnswered(callUUID, friendId, roomName, isVideo, callerName)
    } else {
      IncomingCallModule.notifyDeclined(callUUID, friendId, roomName, isVideo, callerName)
    }

    val uri = Uri.Builder()
      .scheme(SCHEME)
      .authority(HOST)
      .appendPath(friendId)
      .appendQueryParameter("incomingCall", "true")
      .appendQueryParameter("callType", if (isVideo) "video" else "audio")
      .appendQueryParameter("roomName", roomName)
      .appendQueryParameter("friendName", callerName)
      .appendQueryParameter("callUUID", callUUID)
      .appendQueryParameter(if (accept) "acceptCallImmediately" else "declineCall", "true")
      .build()

    val activityIntent = Intent(Intent.ACTION_VIEW, uri).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    context.startActivity(activityIntent)
  }
}
