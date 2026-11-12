// hotkey_tap — native Node addon with two isolated taps:
//   RIGHT command via ordinary flagsChanged events (never consumes them).
//   Media play/pause via systemDefined subtype 8 (the only consumed event).
// Ordinary keyDown/keyUp are deliberately NOT consumed: keycode 16 is Y.
// Debug logging (setDebug / NICO_TAP_DEBUG=1) appends every raw event the
// taps see to ~/.dsh/nico/tap_events.log — used to map headset buttons.
#include <node_api.h>
#include <CoreGraphics/CoreGraphics.h>
#include <Cocoa/Cocoa.h>
#include <atomic>
#include <thread>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <sys/time.h>

static napi_ref g_cb = nullptr;
static CFMachPortRef g_tap = nullptr;
static CFRunLoopSourceRef g_src = nullptr;
static CFMachPortRef g_media_tap = nullptr;
static CFRunLoopSourceRef g_media_src = nullptr;
static std::atomic<bool> g_running{false};
static std::thread* g_thread = nullptr;  // detached; never a joinable static thread
static std::atomic<bool> g_pending{false};
static std::atomic<bool> g_last{false};
static std::atomic<int> g_kind{0};  // 0 = right command, 1 = raw media play/pause
static std::atomic<bool> g_tap_ready{false};
static std::atomic<bool> g_media_ready{false};
static std::atomic<bool> g_debug{false};

// Append-only debug log of raw tap events so headset button presses can be
// mapped to NX keycodes. Off unless setDebug(true).
static void debugLogF(const char* fmt, ...) {
  if (!g_debug.load()) return;
  char line[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof(line), fmt, ap);
  va_end(ap);
  const char* home = getenv("HOME");
  if (!home || !home[0]) return;
  char dir[512];
  snprintf(dir, sizeof(dir), "%s/.dsh", home);
  ::mkdir(dir, 0755);
  snprintf(dir, sizeof(dir), "%s/.dsh/nico", home);
  ::mkdir(dir, 0755);
  char path[600];
  snprintf(path, sizeof(path), "%s/.dsh/nico/tap_events.log", home);
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  struct tm tmBuf;
  localtime_r(&tv.tv_sec, &tmBuf);
  char ts[40];
  strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &tmBuf);
  FILE* f = fopen(path, "a");
  if (f) {
    fprintf(f, "[%s.%03ld] %s\n", ts, (long)(tv.tv_usec / 1000), line);
    fclose(f);
  }
  fprintf(stderr, "[nico-tap] %s\n", line);
}

static const int          kFlagsChanged = 12;
static const int          kSystemDefined = 14;
static const int          kMediaSubtype = 8;
static const int          kMediaDown = 0x0A;
static const int          kMediaUp = 0x0B;
static const int          kMediaPlayPause = 16;
static const int64_t      kNicoMarker = 0x4E49434F;
static const CGEventFlags RIGHT_CMD = (CGEventFlags)1 << 4;

static CGEventRef commandCallback(CGEventTapProxy proxy, CGEventType type,
                                  CGEventRef event, void* refcon) {
  if (type == (CGEventType)kFlagsChanged) {
    CGEventFlags flags = CGEventGetFlags(event);
    debugLogF("flagsChanged: keycode=%lld flags=0x%llX",
              CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode),
              (unsigned long long)flags);
    g_last = (flags & RIGHT_CMD) != 0;
    g_kind = 0;
    g_pending.store(true);
  }
  return event;
}

static CGEventRef mediaCallback(CGEventTapProxy proxy, CGEventType type,
                                CGEventRef event, void* refcon) {
  @autoreleasepool {
    if (type == (CGEventType)kSystemDefined) {
      NSEvent *ns = [NSEvent eventWithCGEvent:event];
      if (ns) {
        int64_t d1 = ns.data1;
        debugLogF("sysDefined: subtype=%ld code=%ld state=0x%02lX data1=0x%llX data2=0x%llX%s",
                  (long)ns.subtype, (long)((d1 >> 16) & 0xFFFF),
                  (long)((d1 >> 8) & 0xFF), (unsigned long long)ns.data1,
                  (unsigned long long)ns.data2,
                  (((d1 >> 16) & 0xFFFF) == kMediaPlayPause) ? " (play/pause)" : "");
      }
      if (ns && ns.subtype == kMediaSubtype) {
        int64_t data1 = ns.data1;
        int code = (data1 >> 16) & 0xFFFF;
        int state = (data1 >> 8) & 0xFF;
        if (code == kMediaPlayPause && (state == kMediaDown || state == kMediaUp)) {
          if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) == kNicoMarker) return event;
          g_last = state == kMediaDown;
          g_kind = 1;
          g_pending.store(true);
          return nullptr;  // MediaHold replays short presses or drives Nico on hold.
        }
      }
    } else if (type == (CGEventType)kCGEventKeyDown || type == (CGEventType)kCGEventKeyUp) {
      debugLogF("key: %s keycode=%lld",
                type == (CGEventType)kCGEventKeyDown ? "down" : "up",
                CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
    }
  }
  return event;
}

static void runTap() {
  g_running = true;
  CFRunLoopRef rl = CFRunLoopGetCurrent();

  CGEventMask commandMask = (CGEventMask)(1 << kFlagsChanged);
  g_tap = CGEventTapCreate((CGEventTapLocation)0, (CGEventTapPlacement)0, (CGEventTapOptions)1,
                           commandMask, commandCallback, nullptr);
  if (g_tap) {
    g_src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
    CFRunLoopAddSource(rl, g_src, kCFRunLoopCommonModes);
    CGEventTapEnable(g_tap, true);
  }

  // Media auxiliary controls require the session event tap, not the HID tap.
  // KeyDown/KeyUp are included passively so debug logging can also see
  // headsets whose buttons surface as ordinary key events, not NX_SYSDEFINED.
  CGEventMask mediaMask = (CGEventMask)((1 << kSystemDefined) | (1 << kCGEventKeyDown) | (1 << kCGEventKeyUp));
  g_media_tap = CGEventTapCreate((CGEventTapLocation)1, (CGEventTapPlacement)0, (CGEventTapOptions)0,
                                 mediaMask, mediaCallback, nullptr);
  if (g_media_tap) {
    g_media_src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_media_tap, 0);
    CFRunLoopAddSource(rl, g_media_src, kCFRunLoopCommonModes);
    CGEventTapEnable(g_media_tap, true);
  }

  g_media_ready = g_media_tap != nullptr;
  g_tap_ready = g_tap != nullptr;
  while (g_running) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
}

static void teardown() {
  g_running = false;
  if (g_thread) {
    for (int i = 0; i < 50; i++) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    delete g_thread;
    g_thread = nullptr;
  }
  if (g_tap) {
    CGEventTapEnable(g_tap, false);
    CFMachPortInvalidate(g_tap);
    CFRelease(g_tap);
    g_tap = nullptr;
  }
  if (g_media_tap) {
    CGEventTapEnable(g_media_tap, false);
    CFMachPortInvalidate(g_media_tap);
    CFRelease(g_media_tap);
    g_media_tap = nullptr;
  }
  if (g_src) { CFRelease(g_src); g_src = nullptr; }
  if (g_media_src) { CFRelease(g_media_src); g_media_src = nullptr; }
  g_tap_ready = false;
  g_media_ready = false;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  napi_value cb, result;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, nullptr, &cb, nullptr);
  napi_create_reference(env, cb, 1, &g_cb);
  g_tap_ready = false;
  g_media_ready = false;
  g_thread = new std::thread(runTap);
  g_thread->detach();
  int spins = 0;
  while (!g_tap_ready.load() && spins < 15) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    spins++;
  }
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Ready(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_get_boolean(env, g_tap_ready.load(), &value);
  return value;
}

static napi_value MediaReady(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_get_boolean(env, g_media_ready.load(), &value);
  return value;
}

static napi_value Drain(napi_env env, napi_callback_info info) {
  bool pending = g_pending.exchange(false);
  bool down = g_last.load();
  int kind = g_kind.load();
  napi_value obj, v1, v2, v3;
  napi_create_object(env, &obj);
  napi_get_boolean(env, pending, &v1);
  napi_set_named_property(env, obj, "pending", v1);
  napi_get_boolean(env, down, &v2);
  napi_set_named_property(env, obj, "down", v2);
  napi_create_int32(env, kind, &v3);
  napi_set_named_property(env, obj, "kind", v3);
  return obj;
}

static bool postMediaState(int state) {
  int64_t data1 = ((int64_t)kMediaPlayPause << 16) | ((int64_t)state << 8);
  NSEvent *ns = [NSEvent otherEventWithType:(NSEventType)kSystemDefined
                                   location:NSZeroPoint
                              modifierFlags:0
                                  timestamp:0
                               windowNumber:0
                                    context:nil
                                    subtype:kMediaSubtype
                                      data1:data1
                                      data2:0];
  if (!ns) return false;
  CGEventRef event = CGEventCreateCopy([ns CGEvent]);
  if (!event) return false;
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, kNicoMarker);
  CGEventPost((CGEventTapLocation)1, event);
  CFRelease(event);
  return true;
}

static napi_value PostPlayPause(napi_env env, napi_callback_info info) {
  bool down = postMediaState(kMediaDown);
  bool up = postMediaState(kMediaUp);
  napi_value value;
  napi_get_boolean(env, down && up, &value);
  return value;
}

static napi_value SetDebug(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool v = false;
  if (argc >= 1) napi_get_value_bool(env, argv[0], &v);
  g_debug.store(v);
  debugLogF("debug %s", v ? "on" : "off");
  napi_value value;
  napi_get_boolean(env, true, &value);
  return value;
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  teardown();
  if (g_cb) { napi_delete_reference(env, g_cb); g_cb = nullptr; }
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "ready", nullptr, Ready, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "mediaReady", nullptr, MediaReady, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "drain", nullptr, Drain, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "postPlayPause", nullptr, PostPlayPause, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setDebug", nullptr, SetDebug, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, 7, props);
  // No napi_add_env_cleanup_hook: it asserted on repeated host reloads.
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
