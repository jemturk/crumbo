package expo.modules.incomingcall

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
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
const val EXTRA_CHAT_MODE = "chatMode"

private const val SCHEME = "crumbo" // app.json "scheme" — must stay in sync.
private const val HOST_KID = "chat" // expo-router route: app/chat/[friendId].tsx
private const val HOST_ADULT = "parent" // expo-router route: app/parent/chat/[code].tsx (path "parent/chat/<code>")

// Deliberately separate from IncomingCallModule's RING_CHANNEL_ID — that one rings the device
// ringtone on a loop (FLAG_INSISTENT); a missed-call notification should just be a normal,
// once-only alert, the same as any other app notification.
private const val MISSED_CALL_CHANNEL_ID = "missed_calls_v1"

private fun ensureMissedCallChannel(context: Context) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
  val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
  if (manager.getNotificationChannel(MISSED_CALL_CHANNEL_ID) != null) return
  manager.createNotificationChannel(
    NotificationChannel(MISSED_CALL_CHANNEL_ID, "Missed calls", NotificationManager.IMPORTANCE_HIGH)
  )
}

// Mirrors IncomingCallModule's own resolveIcon() — duplicated rather than shared since that one
// is a private instance method on a different class and this receiver has no instance of it.
private fun resolveNotificationIcon(context: Context): Int {
  val byName = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
  if (byName != 0) return byName
  val launcher = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName)
  if (launcher != 0) return launcher
  return context.applicationInfo.icon
}

/**
 * Posted directly here (not via JS) so a missed call still notifies the user even if the app's
 * JS process never wakes up at all — this is the ring-timeout alarm's own broadcast, independent
 * of whether anything else in the app is alive. Tapping it opens the conversation normally (no
 * incomingCall params — the ring is already over).
 */
private fun postMissedCallNotification(context: Context, callUUID: String, friendId: String, callerName: String, isVideo: Boolean, chatMode: String) {
  ensureMissedCallChannel(context)

  val uriBuilder = Uri.Builder().scheme(SCHEME)
  val uri = if (chatMode == "adult") {
    uriBuilder.authority(HOST_ADULT).appendPath("chat").appendPath(friendId).build()
  } else {
    uriBuilder.authority(HOST_KID).appendPath(friendId).build()
  }
  val tapIntent = Intent(Intent.ACTION_VIEW, uri).apply {
    setPackage(context.packageName)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }
  val id = callUUID.hashCode() + 1000 // offset from the ringing notification's own id (callUUID.hashCode())
  val tapPendingIntent = PendingIntent.getActivity(
    context, id, tapIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  )

  val notification = NotificationCompat.Builder(context, MISSED_CALL_CHANNEL_ID)
    .setSmallIcon(resolveNotificationIcon(context))
    .setContentTitle(if (isVideo) "Missed video call" else "Missed voice call")
    .setContentText(callerName)
    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
    .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
    .setAutoCancel(true)
    .setContentIntent(tapPendingIntent)
    .build()

  try {
    NotificationManagerCompat.from(context).notify(id, notification)
  } catch (e: SecurityException) {
    // Notification permission not granted — nothing more we can do here.
  }
}

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
 * Accept still launches the app afterward, same as before, so the user sees the live call screen
 * and so the existing deep-link based accept handling in use-call.ts keeps working as a fallback
 * if this event somehow doesn't reach JS in time (e.g. a very cold start). Decline only launches
 * the app when IncomingCallModule.isJsAlive() is false — a backgrounded-but-alive app resolves
 * entirely through the event above, with no need to pull the user into the app just to decline;
 * a fully killed app still needs the launch, since nothing else would deliver the DECLINE_CALL
 * signal to the caller in that case.
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
    val chatMode = intent.getStringExtra(EXTRA_CHAT_MODE) ?: "kid"
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
      // just silence the ring (done above), post a real missed-call notification (guaranteed to
      // fire regardless of whether JS ever wakes up — see postMissedCallNotification), and
      // best-effort tell JS if it's still alive too, so an already-open chat screen can log the
      // miss and let the caller know. If the process is fully dead, the caller's own symmetric
      // ring-timeout (use-call.ts) still resolves their side.
      postMissedCallNotification(context, callUUID, friendId, callerName, isVideo, chatMode)
      IncomingCallModule.notifyMissed(callUUID, friendId, roomName, isVideo, callerName, chatMode)
      return
    }

    if (accept) {
      IncomingCallModule.notifyAnswered(callUUID, friendId, roomName, isVideo, callerName, chatMode)
    } else {
      IncomingCallModule.notifyDeclined(callUUID, friendId, roomName, isVideo, callerName, chatMode)
      if (IncomingCallModule.isJsAlive()) {
        // JS is alive to receive the event above, which is all use-call.ts's
        // onDeclineFromNotification listener needs to send the DECLINE_CALL signal — so there's
        // nothing left to do. Don't yank the user into the app over whatever screen/app they were
        // already on; Telecom is already resolved (above), and that's the whole user-facing action.
        return
      }
      // JS isn't alive to catch that event (app fully killed — a BroadcastReceiver can still run
      // in a freshly spun-up process without any of the RN/JS runtime ever having initialized).
      // Fall through to the same app-launch path as accept so the declineCall=true deep link
      // (use-call.ts's quick-decline effect) boots JS and sends the decline signal itself —
      // otherwise it'd never reach the caller until their own ring-timeout treats this as missed.
    }

    val uriBuilder = Uri.Builder().scheme(SCHEME)
    if (chatMode == "adult") {
      uriBuilder.authority(HOST_ADULT).appendPath("chat").appendPath(friendId)
    } else {
      uriBuilder.authority(HOST_KID).appendPath(friendId)
    }
    val uri = uriBuilder
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
