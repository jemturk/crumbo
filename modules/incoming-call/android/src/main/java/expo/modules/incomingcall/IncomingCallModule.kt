package expo.modules.incomingcall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

private const val LEGACY_CHANNEL_ID = "calling" // Created by expo-notifications in callkeep.ts's setup().

// Our own channel, created natively: rings with the device RINGTONE (not a notification blip),
// which is what makes an incoming call sound like a call. Channels are immutable once created,
// so this must be a NEW id — the legacy 'calling' channel is stuck with default notification sound.
private const val RING_CHANNEL_ID = "incoming_calls_v1"

private const val SCHEME = "crumbo" // app.json "scheme" — must stay in sync.
private const val HOST = "chat" // expo-router route: app/chat/[friendId].tsx

// Mirrors ShowFullScreenIncomingCallParams (modules/incoming-call/index.ts) — JS calls this
// function with a single params object, so the Kotlin side must accept a matching Record
// rather than positional args, or the bridge throws "Cannot convert '[object Object]' to a
// Kotlin type" on every call.
class ShowFullScreenIncomingCallParams : Record {
  @Field
  var callUUID: String = ""

  @Field
  var callerName: String = ""

  @Field
  var isVideo: Boolean = false

  @Field
  var friendId: String = ""

  @Field
  var roomName: String = ""
}

/**
 * Posts a genuinely WhatsApp-style incoming-call notification on Android: `setFullScreenIntent`
 * launches the app straight into its existing ringing UI, bypassing the lock screen, and real
 * Answer/Decline actions work directly from the banner.
 *
 * expo-notifications has no equivalent (no setFullScreenIntent/CallStyle support at all — verified
 * against its Android source), so this is built with a raw NotificationCompat.Builder instead.
 * Routing reuses expo-router's existing `crumbo://chat/<friendId>` deep link — no new native
 * routing logic needed on the RN side (see src/hooks/use-call.ts's incoming-params handling).
 */
class IncomingCallModule : Module() {
  companion object {
    // Set/cleared via OnCreate/OnDestroy below. IncomingCallActionReceiver isn't a Module
    // itself (it can't be — PendingIntent.getBroadcast needs a manifest-declared receiver
    // class, not a DSL-defined one), so this is how it reaches back into JS: call straight
    // into the live module instance rather than trying to go through the module registry.
    @Volatile
    private var activeInstance: IncomingCallModule? = null

    private fun callInfo(callUUID: String, friendId: String, roomName: String, isVideo: Boolean, callerName: String) = mapOf(
      "callUUID" to callUUID,
      "friendId" to friendId,
      "roomName" to roomName,
      "isVideo" to isVideo,
      "callerName" to callerName
    )

    fun notifyAnswered(callUUID: String, friendId: String, roomName: String, isVideo: Boolean, callerName: String) {
      activeInstance?.sendEvent("onAnswerFromNotification", callInfo(callUUID, friendId, roomName, isVideo, callerName))
    }

    fun notifyDeclined(callUUID: String, friendId: String, roomName: String, isVideo: Boolean, callerName: String) {
      activeInstance?.sendEvent("onDeclineFromNotification", callInfo(callUUID, friendId, roomName, isVideo, callerName))
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("IncomingCall")

    // Fired by IncomingCallActionReceiver the instant Answer/Decline is tapped on the
    // notification — see its class doc for why this replaces relying on the deep-link query
    // params (acceptCallImmediately/declineCall) reaching JS via expo-router.
    Events("onAnswerFromNotification", "onDeclineFromNotification")

    OnCreate {
      activeInstance = this@IncomingCallModule
    }

    OnDestroy {
      if (activeInstance === this@IncomingCallModule) {
        activeInstance = null
      }
    }

    Function("showFullScreenIncomingCall") { params: ShowFullScreenIncomingCallParams ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function
      showNotification(params.callUUID, params.callerName, params.isVideo, params.friendId, params.roomName)
    }

    Function("dismiss") { callUUID: String ->
      NotificationManagerCompat.from(context).cancel(notificationId(callUUID))
    }

    // Called by JS once a call has ended — see clearLockScreenFlags() doc comment below.
    Function("clearLockScreenFlags") {
      clearLockScreenFlags()
    }

    Function("isShowing") { callUUID: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@Function false
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        ?: return@Function false
      val id = notificationId(callUUID)
      manager.activeNotifications.any { it.id == id }
    }

    // Android 14+ can silently revoke USE_FULL_SCREEN_INTENT (declaring it in the manifest is
    // no longer sufficient on its own) — without it, showNotification() below still posts the
    // ring + banner but can't bypass the lock screen. JS uses this to decide whether to nudge
    // the user toward the settings screen below.
    Function("canUseFullScreenIntent") {
      canUseFullScreenIntent()
    }

    Function("openFullScreenIntentSettings") {
      // Kotlin's return@Function-with-no-value only type-checks when the DSL infers this
      // closure's return type as Unit outright — an early bare return here fails to compile
      // ("expected Any?, actual Unit") because the DSL's Function<R> builder needs everything
      // to resolve as one expression. Guard with `if` instead of an early return.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
          data = Uri.fromParts("package", context.packageName, null)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
          context.startActivity(intent)
        } catch (e: Exception) {
          // Some OEMs don't ship this settings screen; nothing more we can do.
        }
      }
    }

    // OEM battery optimization (Doze, "sleeping apps", MIUI/ColorOS/FuntouchOS autostart
    // management, etc.) can throttle or kill this app's process before an incoming-call push
    // ever reaches it. Being on the exemption list is what makes delivery reliable.
    Function("isIgnoringBatteryOptimizations") {
      val manager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      manager == null || manager.isIgnoringBatteryOptimizations(context.packageName)
    }

    Function("requestIgnoreBatteryOptimizations") {
      val manager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (manager != null && !manager.isIgnoringBatteryOptimizations(context.packageName)) {
        // Shows a native system Allow/Deny dialog directly — no extra settings navigation needed.
        val requestIntent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
          data = Uri.parse("package:${context.packageName}")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
          context.startActivity(requestIntent)
        } catch (e: Exception) {
          // Some OEMs block the direct-request intent; fall back to the general settings list.
          try {
            val settingsIntent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(settingsIntent)
          } catch (e2: Exception) {
            // Nothing more we can do.
          }
        }
      }
    }

    // A locked/killed device launches straight into MainActivity via the full-screen-intent
    // PendingIntent below — this is the cold-start case, and OnActivityEntersForeground fires
    // for it too (it mirrors Activity#onResume, which a fresh launch also triggers).
    OnActivityEntersForeground {
      applyLockScreenFlags(appContext.currentActivity?.intent?.data)
    }

    // A backgrounded-but-not-killed app instead gets onNewIntent on its existing Activity;
    // Activity#getIntent() is NOT auto-updated in that case, so this needs its own hook reading
    // the intent argument directly, mirroring how expo-linking's own Android module (a real,
    // separate onCreate/onNewIntent split) handles the same cold-start-vs-resume distinction.
    OnNewIntent { intent ->
      applyLockScreenFlags(intent.data)
    }
  }

  private fun notificationId(callUUID: String): Int = callUUID.hashCode()

  private fun canUseFullScreenIntent(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true // auto-granted pre-14
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      ?: return true
    return manager.canUseFullScreenIntent()
  }

  /**
   * `context.applicationInfo.icon` is unreliable here — verified on-device it resolves to 0 in
   * this module's execution context, which crashes notification rendering with
   * `Resources$NotFoundException: Resource ID #0x0` (system_server / Icon logs). Look up the
   * launcher mipmap by name instead, which doesn't depend on ApplicationInfo being fully
   * populated. Falls back to 0 only if even that lookup fails (defensive; shouldn't happen).
   */
  private fun resolveIcon(): Int {
    val byName = context.resources.getIdentifier("ic_launcher", "mipmap", context.packageName)
    if (byName != 0) return byName
    return context.applicationInfo.icon
  }

  private fun buildDeepLink(
    friendId: String,
    callUUID: String,
    isVideo: Boolean,
    roomName: String,
    callerName: String,
    extraKey: String?,
    extraValue: String?
  ): Uri {
    val builder = Uri.Builder()
      .scheme(SCHEME)
      .authority(HOST)
      .appendPath(friendId)
      .appendQueryParameter("incomingCall", "true")
      .appendQueryParameter("callType", if (isVideo) "video" else "audio")
      .appendQueryParameter("roomName", roomName)
      .appendQueryParameter("friendName", callerName)
      .appendQueryParameter("callUUID", callUUID)
    if (extraKey != null && extraValue != null) {
      builder.appendQueryParameter(extraKey, extraValue)
    }
    return builder.build()
  }

  private fun activityPendingIntent(uri: Uri, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, uri).apply {
      setPackage(context.packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getActivity(context, requestCode, intent, flags)
  }

  /**
   * Answer/Decline go through IncomingCallActionReceiver instead of straight to an Activity —
   * see that class's doc for why (resolving Telecom + notifying JS directly, rather than
   * waiting on the app to open and expo-router to notice a query param).
   */
  private fun actionBroadcastPendingIntent(
    action: String,
    callUUID: String,
    friendId: String,
    roomName: String,
    isVideo: Boolean,
    callerName: String,
    requestCode: Int
  ): PendingIntent {
    val intent = Intent(context, IncomingCallActionReceiver::class.java).apply {
      this.action = action
      putExtra(EXTRA_CALL_UUID, callUUID)
      putExtra(EXTRA_FRIEND_ID, friendId)
      putExtra(EXTRA_ROOM_NAME, roomName)
      putExtra(EXTRA_IS_VIDEO, isVideo)
      putExtra(EXTRA_CALLER_NAME, callerName)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getBroadcast(context, requestCode, intent, flags)
  }

  /**
   * expo-notifications' own bundled FCM handling (FirebaseMessagingDelegate.onMessageReceived)
   * unconditionally routes every incoming push — including this module's data-only
   * call-signal pushes — through its own auto-presentation pipeline. Its suppression logic
   * (ExpoHandlingDelegate.shouldPresent, which checks for an empty title/text) doesn't
   * reliably win the race against that on every device/timing — verified on-device: a blank
   * notification on the 'calling' channel shows up alongside our own. Rather than depend on
   * that internal timing, proactively clear anything already on our channel right before
   * posting the real one, so the end state is always just the one notification we built.
   */
  private fun clearStrayChannelNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    try {
      for (sbn in manager.activeNotifications) {
        if (sbn.notification.channelId == LEGACY_CHANNEL_ID || sbn.notification.channelId == RING_CHANNEL_ID) {
          manager.cancel(sbn.tag, sbn.id)
        }
      }
    } catch (e: SecurityException) {
      // Nothing more we can do; our own notify() call below still proceeds normally.
    }
  }

  /**
   * The channel is what makes it SOUND like a call: device ringtone with
   * USAGE_NOTIFICATION_RINGTONE audio attributes, at high importance, with a call-like
   * vibration pattern. Combined with FLAG_INSISTENT on the notification itself, the
   * ringtone loops until the notification is answered, declined, or cancelled — exactly
   * WhatsApp's behavior.
   */
  private fun ensureRingChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (manager.getNotificationChannel(RING_CHANNEL_ID) != null) return

    val audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    val channel = NotificationChannel(RING_CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(Settings.System.DEFAULT_RINGTONE_URI, audioAttributes)
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 1000, 1000)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun showNotification(callUUID: String, callerName: String, isVideo: Boolean, friendId: String, roomName: String) {
    clearStrayChannelNotifications()
    ensureRingChannel()
    val id = notificationId(callUUID)

    val tapUri = buildDeepLink(friendId, callUUID, isVideo, roomName, callerName, null, null)
    val tapPendingIntent = activityPendingIntent(tapUri, id)
    val answerPendingIntent = actionBroadcastPendingIntent(ACTION_ANSWER_CALL, callUUID, friendId, roomName, isVideo, callerName, id + 1)
    val declinePendingIntent = actionBroadcastPendingIntent(ACTION_DECLINE_CALL, callUUID, friendId, roomName, isVideo, callerName, id + 2)

    val caller = Person.Builder()
      .setName(callerName)
      .setImportant(true)
      .build()

    // CallStyle is Android's dedicated incoming-call template — the same one WhatsApp,
    // Signal and the system dialer render with: caller identity up top, full-width
    // green Answer / red Decline buttons. It REPLACES manual addAction() calls (the style
    // generates the buttons from the two PendingIntents). Requires CATEGORY_CALL and a
    // full-screen intent (or FGS), both of which we set. androidx renders a graceful
    // action-button fallback on pre-12 devices.
    val builder = NotificationCompat.Builder(context, RING_CHANNEL_ID)
      .setSmallIcon(resolveIcon())
      .setContentTitle(callerName)
      .setContentText(if (isVideo) "Incoming video call" else "Incoming voice call")
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePendingIntent, answerPendingIntent))
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setOnlyAlertOnce(true) // re-posts for the same call must not restart the ring
      .setContentIntent(tapPendingIntent)

    // Only request the lock-screen bypass if we actually hold the permission — attempting it
    // without holding it doesn't crash, but it silently no-ops, and JS separately nudges the
    // user toward the settings screen when this is false (see canUseFullScreenIntent above).
    if (canUseFullScreenIntent()) {
      builder.setFullScreenIntent(tapPendingIntent, true)
    }

    try {
      val notification = builder.build()
      // Loop the channel's ringtone until the notification is cancelled — the "ring", not a blip.
      notification.flags = notification.flags or Notification.FLAG_INSISTENT
      NotificationManagerCompat.from(context).notify(id, notification)
    } catch (e: SecurityException) {
      // Notification permission not granted — nothing more we can do here; the realtime
      // call_signals subscription still delivers the call to a foregrounded JS instance.
    }
  }

  private fun applyLockScreenFlags(uri: Uri?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return // setShowWhenLocked/setTurnScreenOn are API 27+
    val activity = appContext.currentActivity ?: return

    val isIncomingCall = uri != null && uri.scheme == SCHEME && uri.host == HOST &&
      uri.getQueryParameter("incomingCall") == "true"
    activity.setShowWhenLocked(isIncomingCall)
    activity.setTurnScreenOn(isIncomingCall)
  }

  /**
   * applyLockScreenFlags() above only ever sets showWhenLocked/turnScreenOn to true (when an
   * incoming-call deep link opens the app) — nothing previously reset them to false once the
   * call ended, so the app kept floating over the lock screen for a while after hangup. JS
   * calls this right after tearing a call down to clear that state immediately.
   */
  private fun clearLockScreenFlags() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return
    val activity = appContext.currentActivity ?: return
    activity.setShowWhenLocked(false)
    activity.setTurnScreenOn(false)
  }
}
