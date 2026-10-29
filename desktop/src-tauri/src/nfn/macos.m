#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <WebKit/WebKit.h>
#import <Intents/Intents.h>
#import <UserNotifications/UserNotifications.h>
#import <ApplicationServices/ApplicationServices.h>
#include <errno.h>
#include <stdlib.h>

typedef void (*NfnCallback)(const char *);
static NfnCallback callback;

@interface NfnWebView : WKWebView
@end
@implementation NfnWebView
// Deliver the activating mouse-down to buttons, reply fields, and drag handles.
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end

@interface NfnPanel : NSPanel
@property BOOL textFocus;
@property BOOL keyboardFocus;
@end
@implementation NfnPanel
- (BOOL)canBecomeKeyWindow { return self.textFocus || self.keyboardFocus; }
- (BOOL)canBecomeMainWindow { return NO; }
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    // The daemon has no Edit menu to route these commands to WebKit.
    NSEventModifierFlags modifiers = event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift);
    if (self.textFocus && event.type == NSEventTypeKeyDown && (modifiers == NSEventModifierFlagCommand || modifiers == (NSEventModifierFlagCommand | NSEventModifierFlagShift))) {
        NSString *key = event.charactersIgnoringModifiers.lowercaseString;
        NSString *action = modifiers & NSEventModifierFlagShift ? ([key isEqual:@"z"] ? @"redo:" : nil) : @{@"a":@"selectAll:", @"c":@"copy:", @"x":@"cut:", @"v":@"paste:", @"z":@"undo:"}[key];
        if (action && [self.firstResponder tryToPerform:NSSelectorFromString(action) with:self]) return YES;
    }
    return [super performKeyEquivalent:event];
}
// Keep the notch surface attached to the physical top edge of the screen.
- (NSRect)constrainFrameRect:(NSRect)frame toScreen:(NSScreen *)screen { return frame; }
@end

@interface NfnSurface : NSObject <WKScriptMessageHandler, WKNavigationDelegate, WKURLSchemeHandler>
@property NfnPanel *panel;
@property WKWebView *web;
@property NSDictionary *snapshot;
@property NSDictionary *settings;
@property NSMutableDictionary<NSString *, NSString *> *media;
@property NSHashTable *stoppedTasks;
@property NSTimer *timer;
@property NSString *lastPlatform;
@property BOOL authorized;
@property BOOL soundAllowed;
@property BOOL authorizationKnown;
@property BOOL ready;
@property NSRunningApplication *previousApplication;
@property EventHotKeyRef focusHotKey;
@property EventHandlerRef hotKeyHandler;
@property NSString *registeredShortcut;
@property NSString *shortcutError;
@property id keyboardMonitor;
@property NSTimeInterval optionPressedAt;
@property NSTimeInterval optionReleasedAt;
@property NSUInteger optionTaps;
@property id mouseMonitor;
@property id localMouseMonitor;
@property NSUInteger ticks;
@property CGFloat surfaceWidth;
@property CGFloat surfaceHeight;
@property CGFloat surfaceRightOffset;
@property BOOL notchPlacement;
@property NSString *lastGeometry;
@property NSMutableDictionary<NSString *, NSDictionary *> *notchGeometry;
@property BOOL dragging;
@property NSPoint dragAnchor;
@property NSPoint dragPointerOrigin;
@property BOOL settingsVisible;
@property BOOL notificationsVisible;
@property NSStatusItem *statusItem;
@property NSImage *statusIcon;
@property BOOL pointerDown;
@property BOOL screenSleeping;
@property BOOL screenLocked;
@property NSDictionary *pendingPresentation;
- (void)toggleKeyboardFocus;
- (void)endKeyboardFocus:(BOOL)restore;
@end

static NfnSurface *surface;

static BOOL unsignedNumber(NSString *text, unsigned long long *number) {
    if (!text.length || [text rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet]].location != NSNotFound) return NO;
    errno = 0;
    char *end;
    *number = strtoull(text.UTF8String, &end, 10);
    return errno != ERANGE && !*end;
}

static void emit(NSDictionary *value) {
    if (!callback) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (data) callback([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}

static OSStatus focusHotKeyHandler(EventHandlerCallRef next, EventRef event, void *context) {
    (void)next; (void)event; (void)context;
    [surface toggleKeyboardFocus];
    return noErr;
}

@implementation NfnSurface
- (instancetype)initWithHTML:(NSString *)html statusIcon:(NSImage *)icon {
    if (!(self = [super init])) return nil;
    self.settings = @{};
    self.statusIcon = icon;
    self.notchGeometry = [NSMutableDictionary dictionary];
    for (NSScreen *screen in NSScreen.screens) [self notchForScreen:screen];
    self.media = [NSMutableDictionary dictionary];
    self.stoppedTasks = [NSHashTable weakObjectsHashTable];
    self.panel = [[NfnPanel alloc] initWithContentRect:NSMakeRect(0, 0, 220, 40)
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
    self.panel.animationBehavior = NSWindowAnimationBehaviorNone;
    self.panel.hidesOnDeactivate = NO;
    self.panel.becomesKeyOnlyIfNeeded = YES;
    self.panel.floatingPanel = YES;
    // Enabling floatingPanel resets the level to NSFloatingWindowLevel.
    self.panel.level = NSStatusWindowLevel;
    self.panel.opaque = NO;
    self.panel.backgroundColor = NSColor.clearColor;
    self.panel.hasShadow = NO;
    self.panel.releasedWhenClosed = NO;
    self.panel.acceptsMouseMovedEvents = YES;
    self.panel.title = @"ClawTab notifications";
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    [configuration.userContentController addScriptMessageHandler:self name:@"nfn"];
    [configuration setURLSchemeHandler:self forURLScheme:@"clawtab-nfn"];
    configuration.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeAll;
    self.web = [[NfnWebView alloc] initWithFrame:self.panel.contentView.bounds configuration:configuration];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self;
    [self.web setValue:@NO forKey:@"drawsBackground"];
    if (@available(macOS 12.0, *)) self.web.underPageBackgroundColor = NSColor.clearColor;
    [self.panel.contentView addSubview:self.web];
    [self.web loadHTMLString:html baseURL:[NSURL URLWithString:@"clawtab-nfn://surface/"]];
    __weak NfnSurface *weakSelf = self;
    self.timer = [NSTimer scheduledTimerWithTimeInterval:2 repeats:YES block:^(NSTimer *timer) {
        NfnSurface *self = weakSelf;
        if (!self) { [timer invalidate]; return; }
        self.ticks++;
        if (self.ticks % 3 == 0) [self refreshAuthorization];
        if (!self.dragging && [self.settings[@"display"] isEqual:@"pointer"] && [self selectedScreen] != self.panel.screen) [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
        [self publishPlatform];
        if (![self allowsOverlay]) { [self.panel orderOut:nil]; [self releaseTextFocus]; }
    }];
    self.keyboardMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged | NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        NfnSurface *self = weakSelf;
        if (!self.panel.isKeyWindow) { self.optionTaps = 0; self.optionPressedAt = 0; return event; }
        NSUInteger flags = event.modifierFlags & (NSEventModifierFlagOption | NSEventModifierFlagCommand | NSEventModifierFlagShift | NSEventModifierFlagControl);
        BOOL option = event.keyCode == kVK_Option || event.keyCode == kVK_RightOption;
        if (event.type == NSEventTypeKeyDown || !option || (flags && flags != NSEventModifierFlagOption)) {
            self.optionTaps = 0; self.optionPressedAt = 0; return event;
        }
        if (flags == NSEventModifierFlagOption) {
            if (event.timestamp - self.optionReleasedAt > .3) self.optionTaps = 0;
            self.optionPressedAt = event.timestamp;
        } else if (self.optionPressedAt && event.timestamp - self.optionPressedAt <= .2) {
            self.optionPressedAt = 0; self.optionReleasedAt = event.timestamp;
            if (++self.optionTaps == 2) { self.optionTaps = 0; [self push:@{@"type":@"toggle_hints"}]; }
        } else { self.optionTaps = 0; self.optionPressedAt = 0; }
        return event;
    }];
    NSEventMask pointerEvents = NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged | NSEventMaskRightMouseDragged | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskLeftMouseUp;
    self.mouseMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:pointerEvents handler:^(NSEvent *event) {
        NfnSurface *self = weakSelf;
        [self handleDragEvent:event];
        if (event.type == NSEventTypeLeftMouseUp) self.pointerDown = NO;
        [self updateMousePassthrough];
        if ((event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown) && self.panel.visible && !NSPointInRect(NSEvent.mouseLocation, [self surfaceFrame])) {
            [self endKeyboardFocus:NO];
            [self releaseTextFocus];
            [self.web evaluateJavaScript:@"window.nfn && window.nfn.outsideClick()" completionHandler:nil];
        }
    }];
    self.localMouseMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:pointerEvents handler:^NSEvent *(NSEvent *event) {
        NfnSurface *self = weakSelf;
        if (event.type == NSEventTypeLeftMouseDown && event.window == self.panel) {
            self.pointerDown = YES;
            self.dragPointerOrigin = [self.panel convertPointToScreen:event.locationInWindow];
        }
        BOOL moved = [self handleDragEvent:event];
        if (event.type == NSEventTypeLeftMouseUp) self.pointerDown = NO;
        [self updateMousePassthrough];
        // Once dragging starts, move the panel without a WebKit round trip.
        if (moved) return nil;
        return event;
    }];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(screensChanged:) name:NSApplicationDidChangeScreenParametersNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(screensChanged:) name:NSWorkspaceActiveSpaceDidChangeNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(activationChanged:) name:NSWorkspaceDidActivateApplicationNotification object:nil];
    for (NSString *name in @[NSWorkspaceScreensDidSleepNotification, NSWorkspaceWillSleepNotification, NSWorkspaceScreensDidWakeNotification, NSWorkspaceDidWakeNotification])
        [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(powerChanged:) name:name object:nil];
    for (NSString *name in @[@"com.apple.screenIsLocked", @"com.apple.screenIsUnlocked"])
        [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(lockChanged:) name:name object:nil];
    if (NSBundle.mainBundle.bundleIdentifier) {
        [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
            (void)granted; (void)error;
            dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf refreshAuthorization]; });
        }];
    }
    [self refreshAuthorization];
    return self;
}

- (void)activationChanged:(NSNotification *)notification {
    NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
    if (app.processIdentifier != NSProcessInfo.processInfo.processIdentifier) [self endKeyboardFocus:NO];
    [self publishPlatform];
}
- (void)powerChanged:(NSNotification *)notification {
    self.screenSleeping = [notification.name isEqual:NSWorkspaceScreensDidSleepNotification] || [notification.name isEqual:NSWorkspaceWillSleepNotification];
    if (self.screenSleeping) [self endKeyboardFocus:NO];
    [self publishPlatform];
}
- (void)lockChanged:(NSNotification *)notification {
    self.screenLocked = [notification.name isEqual:@"com.apple.screenIsLocked"];
    if (self.screenLocked) [self endKeyboardFocus:NO];
    [self publishPlatform];
}
- (void)updateStatusItem {
    BOOL enabled = !self.settings[@"menu_bar_icon"] || [self.settings[@"menu_bar_icon"] boolValue];
    if (!enabled) {
        if (self.statusItem) [NSStatusBar.systemStatusBar removeStatusItem:self.statusItem];
        self.statusItem = nil;
        return;
    }
    if (self.statusItem) return;
    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
    self.statusItem.button.image = self.statusIcon;
    self.statusItem.button.toolTip = @"ClawTab notifications";
    self.statusItem.button.accessibilityLabel = @"ClawTab notifications";
    self.statusItem.button.target = self;
    self.statusItem.button.action = @selector(openNotifications:);
}
- (void)openNotifications:(id)sender { [self push:@{@"type":@"latest"}]; }
- (void)screensChanged:(NSNotification *)notification {
    NSMutableSet *connected = [NSMutableSet set];
    for (NSScreen *screen in NSScreen.screens) [connected addObject:[screen.deviceDescription[@"NSScreenNumber"] stringValue]];
    for (NSString *identifier in self.notchGeometry.allKeys) if (![connected containsObject:identifier]) [self.notchGeometry removeObjectForKey:identifier];
    [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
    [self publishPlatform];
}

- (void)refreshAuthorization {
    if (!NSBundle.mainBundle.bundleIdentifier) return;
    __weak NfnSurface *weakSelf = self;
    [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NfnSurface *self = weakSelf;
            self.authorizationKnown = settings.authorizationStatus != UNAuthorizationStatusNotDetermined;
            self.authorized = settings.authorizationStatus == UNAuthorizationStatusAuthorized || settings.authorizationStatus == UNAuthorizationStatusProvisional;
            self.soundAllowed = self.authorized && settings.soundSetting == UNNotificationSettingEnabled;
            [self publishPlatform];
        });
    }];
}

- (id)focusStatus {
    if (@available(macOS 12.0, *)) { return INFocusStatusCenter.defaultCenter.focusStatus.isFocused ?: NSNull.null; }
    return NSNull.null;
}

- (BOOL)allowsOverlay {
    if (self.settingsVisible || self.notificationsVisible) return YES;
    if ([self.settings[@"delivery"] isEqual:@"native"]) return NO;
    if ([self.settings[@"focus"] isEqual:@"independent"]) return YES;
    id focused = [self focusStatus];
    return self.authorizationKnown && self.authorized && focused != NSNull.null && ![focused boolValue];
}

- (void)requestFocusIfNeeded {
    if (@available(macOS 12.0, *)) {
        if (![self.settings[@"focus"] isEqual:@"follow"] || !NSBundle.mainBundle.bundleIdentifier
            || ![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSFocusStatusUsageDescription"]) return;
        if (INFocusStatusCenter.defaultCenter.authorizationStatus == INFocusStatusAuthorizationStatusNotDetermined
            && ![NSUserDefaults.standardUserDefaults boolForKey:@"NfnFocusAccessRequested"]) {
            [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"NfnFocusAccessRequested"];
            __weak NfnSurface *weakSelf = self;
            [INFocusStatusCenter.defaultCenter requestAuthorizationWithCompletionHandler:^(INFocusStatusAuthorizationStatus status) {
                (void)status;
                dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf publishPlatform]; });
            }];
        }
    }
}

- (void)publishPlatform {
    NSMutableArray *displays = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {
        NSString *identifier = [screen.deviceDescription[@"NSScreenNumber"] stringValue];
        [displays addObject:@{@"id":identifier ?: @"", @"name":screen.localizedName ?: @"Display"}];
    }
    NSTimeInterval idle = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    BOOL locked = self.screenLocked || [session[@"CGSSessionScreenIsLocked"] boolValue];
    BOOL sleeping = self.screenSleeping;
    NSUInteger idleLimit = [self.settings[@"idle_seconds"] unsignedIntegerValue] ?: 60;
    NSDictionary *state = @{@"focus_shortcut_error":self.shortcutError ?: @"", @"available":@YES, @"focused":[self focusStatus],
        @"authorized":self.authorizationKnown ? @(self.authorized) : NSNull.null, @"sound_allowed":@(self.soundAllowed),
        @"frontmost_pid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier), @"user_active":@((BOOL)(idle < idleLimit && !sleeping && !locked)),
        @"idle_seconds":@((NSUInteger)idle), @"screen_sleeping":@(sleeping), @"screen_locked":@(locked), @"displays":displays};
    NSString *serialized = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:state options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding];
    if (![serialized isEqual:self.lastPlatform]) {
        self.lastPlatform = serialized;
        emit(@{@"command":@{@"op":@"platform",@"state":state}});
    }
}

- (NSScreen *)selectedScreen {
    NSArray<NSScreen *> *screens = NSScreen.screens;
    NSString *selection = self.settings[@"display"] ?: @"primary";
    if ([selection isEqual:@"pointer"]) {
        for (NSScreen *screen in screens) if (NSPointInRect(NSEvent.mouseLocation, screen.frame)) return screen;
    } else if ([selection isEqual:@"built_in"]) {
        for (NSScreen *screen in screens) if (CGDisplayIsBuiltin([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue])) return screen;
    } else if (![selection isEqual:@"primary"]) {
        for (NSScreen *screen in screens) if ([[screen.deviceDescription[@"NSScreenNumber"] stringValue] isEqual:selection]) return screen;
    }
    return screens.firstObject;
}

- (NSDictionary *)notchForScreen:(NSScreen *)screen {
    NSString *identifier = [screen.deviceDescription[@"NSScreenNumber"] stringValue];
    CGFloat topInset = 0, notchWidth = 0;
    CGFloat center = NSMidX(screen.frame);
    if (@available(macOS 12.0, *)) {
        topInset = screen.safeAreaInsets.top;
        if (topInset > 0) {
            notchWidth = NSMinX(screen.auxiliaryTopRightArea) - NSMaxX(screen.auxiliaryTopLeftArea);
            center = NSMaxX(screen.auxiliaryTopLeftArea) + notchWidth / 2;
        }
    }
    NSDictionary *previous = self.notchGeometry[identifier];
    // AppKit can temporarily return empty camera areas after the overlay opens.
    // Retain measured hardware geometry only while the display mode is unchanged.
    if (topInset <= 0 && previous && NSEqualRects([previous[@"frame"] rectValue], screen.frame)
        && [previous[@"scale"] doubleValue] == screen.backingScaleFactor) return previous;
    NSDictionary *geometry = @{@"inset":@(topInset), @"width":@(MAX(0, notchWidth)), @"center":@(center),
        @"frame":[NSValue valueWithRect:screen.frame], @"scale":@(screen.backingScaleFactor)};
    self.notchGeometry[identifier] = geometry;
    return geometry;
}

- (void)positionWidth:(CGFloat)width height:(CGFloat)height {
    if (self.dragging) return;
    NSScreen *screen = [self selectedScreen];
    if (!screen || width <= 0 || height <= 0) return;
    NSDictionary *camera = [self notchForScreen:screen];
    CGFloat topInset = [camera[@"inset"] doubleValue], notchWidth = [camera[@"width"] doubleValue];
    BOOL notch = [self.settings[@"placement"] isEqual:@"notch"] && topInset > 0;
    self.notchPlacement = notch;
    NSRect available = screen.visibleFrame;
    CGFloat overlap = notch ? topInset : 0;
    // Keep WebKit's canvas still. Only the shape inside it changes size.
    CGFloat w = MIN(available.size.width - 32, MAX(680, available.size.width - 32 - (notch ? 0 : MIN(384, available.size.width / 3))));
    CGFloat h = MIN(900, available.size.height - 32);
    CGFloat x = notch ? [camera[@"center"] doubleValue] - w / 2 : NSMaxX(available) - w - MIN(384, available.size.width / 3);
    x = MAX(NSMinX(available) + 16, MIN(x, NSMaxX(available) - w - 16));
    CGFloat y = notch ? NSMaxY(screen.frame) - h : NSMaxY(available) - h - 12;
    if ([self.settings[@"placement"] isEqual:@"custom"] && [self.settings[@"position"] isKindOfClass:NSDictionary.class]) {
        NSDictionary *position = self.settings[@"position"];
        CGFloat right = NSMaxX(available) - [position[@"right"] doubleValue];
        CGFloat top = NSMaxY(available) - [position[@"top"] doubleValue];
        right = MAX(NSMinX(available) + MIN(width, w), MIN(right, NSMaxX(available)));
        top = MAX(NSMinY(available) + MIN(height, h), MIN(top, NSMaxY(available)));
        x = right - w; y = top - h;
    }
    if (!notch) x += MAX(NSMinX(available) + MIN(width, w) - (x + w), MIN(self.surfaceRightOffset, NSMaxX(available) - 16 - (x + w)));
    NSRect frame = NSMakeRect(x, y, w, h);
    if (!NSEqualRects(frame, self.panel.frame)) [self.panel setFrame:frame display:YES];
    [self updateMousePassthrough];
    NSDictionary *geometry = @{@"placement":notch ? @"notch" : @"right", @"overlap":@(overlap),
        @"notch_width":@(MAX(0, notchWidth)), @"max_width":@(w),
        @"max_width_e":@(MIN(w, width + NSMaxX(available) - 16 - (x + w))),
        @"max_height":@(h), @"reduce_motion":@(NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion)};
    NSString *json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:geometry options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding];
    if (self.ready && ![json isEqual:self.lastGeometry]) {
        self.lastGeometry = json;
        [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.nfn.setPlacement(%@)", json] completionHandler:nil];
    }
}

- (BOOL)handleDragEvent:(NSEvent *)event {
    if (!self.dragging) return NO;
    if (event.type == NSEventTypeLeftMouseDragged || event.type == NSEventTypeLeftMouseUp) {
        NSPoint pointer = event.window ? [event.window convertPointToScreen:event.locationInWindow] : NSEvent.mouseLocation;
        [self drag:@{@"phase":@"move", @"dx":@(pointer.x - self.dragPointerOrigin.x), @"dy":@(self.dragPointerOrigin.y - pointer.y)}];
        if (event.type == NSEventTypeLeftMouseUp) [self drag:@{@"phase":@"end"}];
    }
    return event.type == NSEventTypeLeftMouseDragged;
}

- (void)drag:(NSDictionary *)value {
    NSString *phase = value[@"phase"];
    if ([phase isEqual:@"start"]) {
        NSRect frame = [self surfaceFrame];
        CGFloat overlap = self.notchPlacement ? [[self notchForScreen:[self selectedScreen]][@"inset"] doubleValue] : 0;
        self.dragAnchor = NSMakePoint(NSMaxX(frame), NSMaxY(frame) - overlap);
        self.dragging = YES;
        self.surfaceRightOffset = 0;
        self.notchPlacement = NO;
        self.lastGeometry = nil;
        [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.nfn.setPlacement({placement:'right',overlap:0,max_width:%g,max_height:%g,reduce_motion:true})", self.panel.frame.size.width, self.panel.frame.size.height] completionHandler:nil];
        [self drag:@{@"phase":@"move", @"dx":value[@"dx"] ?: @0, @"dy":value[@"dy"] ?: @0}];
    } else if ([phase isEqual:@"move"] && self.dragging) {
        NSRect frame = self.panel.frame;
        frame.origin.x = self.dragAnchor.x + [value[@"dx"] doubleValue] - frame.size.width;
        frame.origin.y = self.dragAnchor.y - [value[@"dy"] doubleValue] - frame.size.height;
        [self.panel setFrameOrigin:frame.origin];
        self.panel.ignoresMouseEvents = NO;
    } else if ([phase isEqual:@"end"] && self.dragging) {
        self.dragging = NO;
        NSScreen *screen = nil;
        for (NSScreen *candidate in NSScreen.screens) if (NSPointInRect(NSEvent.mouseLocation, candidate.frame)) { screen = candidate; break; }
        screen = screen ?: self.panel.screen ?: [self selectedScreen];
        NSRect available = screen.visibleFrame;
        NSDictionary *position = @{@"right":@(MAX(0, NSMaxX(available) - NSMaxX(self.panel.frame))), @"top":@(MAX(0, NSMaxY(available) - NSMaxY(self.panel.frame)))};
        NSString *display = [screen.deviceDescription[@"NSScreenNumber"] stringValue];
        NSMutableDictionary *settings = [self.settings mutableCopy];
        settings[@"placement"] = @"custom"; settings[@"position"] = position; settings[@"display"] = display;
        self.settings = settings;
        [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
        emit(@{@"command":@{@"op":@"set_position", @"display":display, @"position":position}});
    }
}

- (NSRect)surfaceFrame {
    NSRect frame = self.panel.frame;
    CGFloat width = MIN(self.surfaceWidth, frame.size.width), height = MIN(self.surfaceHeight, frame.size.height);
    CGFloat x = self.notchPlacement ? NSMidX(frame) - width / 2 : NSMaxX(frame) - width;
    return NSMakeRect(x, NSMaxY(frame) - height, width, height);
}

- (void)updateMousePassthrough {
    self.panel.ignoresMouseEvents = !self.pointerDown && !self.dragging && !NSPointInRect(NSEvent.mouseLocation, [self surfaceFrame]);
}

- (void)configureFocusShortcut {
    NSString *binding = self.settings[@"focus_shortcut"] ?: @"Ctrl+Alt+w";
    if ([binding isEqual:self.registeredShortcut]) return;
    if (self.focusHotKey) { UnregisterEventHotKey(self.focusHotKey); self.focusHotKey = NULL; }
    self.registeredShortcut = binding; self.shortcutError = @"";
    if (binding.length) {
        NSArray *parts = [binding.lowercaseString componentsSeparatedByString:@"+"];
        UInt32 modifiers = 0; BOOL valid = parts.count > 1;
        for (NSString *part in [parts subarrayWithRange:NSMakeRange(0, parts.count - 1)]) {
            if ([part isEqual:@"ctrl"]) modifiers |= controlKey;
            else if ([part isEqual:@"alt"] || [part isEqual:@"option"]) modifiers |= optionKey;
            else if ([part isEqual:@"shift"]) modifiers |= shiftKey;
            else if ([part isEqual:@"meta"] || [part isEqual:@"cmd"]) modifiers |= cmdKey;
            else valid = NO;
        }
        NSDictionary *codes = @{@"a":@0,@"s":@1,@"d":@2,@"f":@3,@"h":@4,@"g":@5,@"z":@6,@"x":@7,@"c":@8,@"v":@9,@"b":@11,@"q":@12,@"w":@13,@"e":@14,@"r":@15,@"y":@16,@"t":@17,@"1":@18,@"2":@19,@"3":@20,@"4":@21,@"6":@22,@"5":@23,@"9":@25,@"7":@26,@"8":@28,@"0":@29,@"o":@31,@"u":@32,@"i":@34,@"p":@35,@"l":@37,@"j":@38,@"k":@40,@"n":@45,@"m":@46,@"space":@49};
        NSNumber *code = codes[parts.lastObject];
        if (!self.hotKeyHandler) {
            EventTypeSpec type = {kEventClassKeyboard, kEventHotKeyPressed};
            InstallApplicationEventHandler(focusHotKeyHandler, 1, &type, NULL, &_hotKeyHandler);
        }
        EventHotKeyID identifier = {'cwnf', 1};
        OSStatus status = valid && modifiers && code ? RegisterEventHotKey(code.unsignedIntValue, modifiers, identifier, GetApplicationEventTarget(), 0, &_focusHotKey) : paramErr;
        if (status != noErr) self.shortcutError = [NSString stringWithFormat:@"Could not register focus shortcut %@ (%d)", binding, (int)status];
    }
    [self push:@{@"type":@"shortcut_status",@"error":self.shortcutError}];
}

- (void)toggleKeyboardFocus {
    if (self.panel.isKeyWindow) { [self push:@{@"type":@"keyboard_collapse"}]; [self endKeyboardFocus:YES]; return; }
    if (self.screenLocked || self.screenSleeping) return;
    self.previousApplication = NSWorkspace.sharedWorkspace.frontmostApplication;
    self.panel.keyboardFocus = YES;
    self.notificationsVisible = YES;
    [self push:@{@"type":@"keyboard_focus",@"active":@YES}];
    [NSApp activateIgnoringOtherApps:YES];
    [self.panel makeKeyAndOrderFront:nil];
    [self.panel makeFirstResponder:self.web];
}

- (void)endKeyboardFocus:(BOOL)restore {
    self.optionTaps = 0; self.optionPressedAt = 0;
    if (!self.panel.keyboardFocus) return;
    self.panel.keyboardFocus = NO;
    NSRunningApplication *previous = self.previousApplication; self.previousApplication = nil;
    self.panel.textFocus = NO; [self.panel makeFirstResponder:nil]; [self.panel resignKeyWindow];
    if (restore && previous && !previous.terminated) [previous activateWithOptions:NSApplicationActivateIgnoringOtherApps];
}

- (void)releaseTextFocus {
    if (!self.panel.textFocus) return;
    self.panel.textFocus = NO;
    if (!self.panel.keyboardFocus) { [self.panel makeFirstResponder:nil]; [self.panel resignKeyWindow]; }
}

- (void)push:(NSDictionary *)value {
    if ([value[@"type"] isEqual:@"settings"]) {
        self.settingsVisible = YES;
        if (!self.ready) self.pendingPresentation = value;
    }
    if ([value[@"type"] isEqual:@"show"] || [value[@"type"] isEqual:@"latest"]) {
        self.notificationsVisible = YES;
        if (!self.ready) self.pendingPresentation = value;
    }
    if ([value[@"type"] isEqual:@"snapshot"]) {
        self.snapshot = value;
        self.settings = value[@"settings"] ?: @{};
        [self updateStatusItem];
        [self configureFocusShortcut];
        [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
        [self.media removeAllObjects];
        for (NSDictionary *record in value[@"records"]) {
            NSArray *media = record[@"request"][@"media"];
            for (NSUInteger i=0; i<media.count; i++) {
                NSString *src = media[i][@"src"];
                if ([src hasPrefix:@"/"]) self.media[[NSString stringWithFormat:@"/%@/%lu",record[@"id"],(unsigned long)i]] = src;
            }
        }
        [self requestFocusIfNeeded];
        if (!self.settingsVisible && !self.notificationsVisible && (![value[@"visible"] boolValue] || ![self allowsOverlay])) { [self.panel orderOut:nil]; [self releaseTextFocus]; }
        if ([value[@"sound"] boolValue] && [value[@"visible"] boolValue] && [self allowsOverlay]) {
            if ([self.settings[@"focus"] isEqual:@"independent"] || self.soundAllowed) [[NSSound soundNamed:@"Glass"] play];
        }
    }
    if (!self.ready) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.nfn.receive(%@)", json] completionHandler:nil];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.ready = YES;
    [self push:@{@"type":@"shortcut_status",@"error":self.shortcutError ?: @""}];
    if (self.snapshot) [self push:self.snapshot];
    if (self.pendingPresentation) { NSDictionary *value = self.pendingPresentation; self.pendingPresentation = nil; [self push:value]; }
    [self publishPlatform];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:NSDictionary.class] || !message.frameInfo.mainFrame) return;
    NSDictionary *value = message.body;
    NSString *operation = value[@"native"];
    if ([operation isEqual:@"surface"]) {
        self.surfaceWidth = [value[@"width"] doubleValue]; self.surfaceHeight = [value[@"height"] doubleValue];
        self.surfaceRightOffset = [value[@"right_offset"] doubleValue];
        if (self.surfaceWidth < 1 || self.surfaceHeight < 1) { [self.panel orderOut:nil]; [self releaseTextFocus]; return; }
        [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
        if (!self.panel.visible && (self.settingsVisible || self.notificationsVisible || [self.snapshot[@"visible"] boolValue]) && [self allowsOverlay]) [self.panel orderFrontRegardless];
    } else if ([operation isEqual:@"settings"] || [operation isEqual:@"presentation"]) {
        if ([operation isEqual:@"settings"]) self.settingsVisible = [value[@"active"] boolValue];
        else self.notificationsVisible = [value[@"active"] boolValue];
        if (self.settingsVisible || self.notificationsVisible) [self.panel orderFrontRegardless];
        else if (![self.snapshot[@"visible"] boolValue] || ![self allowsOverlay]) { [self.panel orderOut:nil]; [self releaseTextFocus]; }
    } else if ([operation isEqual:@"drag"]) {
        [self drag:value];
    } else if ([operation isEqual:@"keyboard_exit"]) {
        [self endKeyboardFocus:[value[@"restore"] boolValue]];
    } else if ([operation isEqual:@"text_focus"]) {
        if ([value[@"active"] boolValue]) {
            self.panel.textFocus = YES;
            // Keep WebKit's clicked field as the first responder when taking focus.
            if (!self.panel.isKeyWindow) {
                [NSApp activateIgnoringOtherApps:YES];
                [self.panel makeKeyAndOrderFront:nil];
            }
        }
        else [self releaseTextFocus];
    } else if (!operation && value[@"command"]) emit(value);
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    NSString *scheme = action.request.URL.scheme;
    handler(([scheme isEqual:@"about"] || [scheme isEqual:@"clawtab-nfn"]) ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSString *path = self.media[task.request.URL.path];
    if (!path) { [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil]]; return; }
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    unsigned long long total = [attributes fileSize], start = 0, end = total ? total-1 : 0;
    NSString *range = [task.request valueForHTTPHeaderField:@"Range"];
    BOOL partial = [range hasPrefix:@"bytes="];
    if (partial) {
        NSArray *parts = [[range substringFromIndex:6] componentsSeparatedByString:@"-"];
        unsigned long long value;
        if (parts.count != 2 || (![parts[0] length] && ![parts[1] length])) {
            [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil]]; return;
        }
        if (![parts[0] length]) {
            if (!unsignedNumber(parts[1], &value) || !value) { [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil]]; return; }
            start = total - MIN(total, value);
        } else {
            if (!unsignedNumber(parts[0], &start) || ([parts[1] length] && !unsignedNumber(parts[1], &value))) {
                [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadURL userInfo:nil]]; return;
            }
            if ([parts[1] length]) end = MIN(end, value);
        }
    }
    if (!total || start >= total || end < start) { [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotDecodeContentData userInfo:nil]]; return; }
    NSDictionary *types = @{@"png":@"image/png",@"jpg":@"image/jpeg",@"jpeg":@"image/jpeg",@"webp":@"image/webp",@"gif":@"image/gif",@"mp4":@"video/mp4",@"mov":@"video/quicktime",@"webm":@"video/webm"};
    NSMutableDictionary *headers = [@{@"Content-Type":types[path.pathExtension.lowercaseString] ?: @"application/octet-stream",@"Accept-Ranges":@"bytes",@"Content-Length":[NSString stringWithFormat:@"%llu",end-start+1],@"Access-Control-Allow-Origin":@"*"} mutableCopy];
    if (partial) headers[@"Content-Range"] = [NSString stringWithFormat:@"bytes %llu-%llu/%llu",start,end,total];
    [task didReceiveResponse:[[NSHTTPURLResponse alloc] initWithURL:task.request.URL statusCode:partial ? 206 : 200 HTTPVersion:@"HTTP/1.1" headerFields:headers]];
    // File reads run off the application thread and are bounded to one chunk.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{
        NSFileHandle *file = [NSFileHandle fileHandleForReadingAtPath:path];
        if (!file) { dispatch_async(dispatch_get_main_queue(), ^{ if (![self.stoppedTasks containsObject:task]) [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil]]; }); return; }
        @try {
            [file seekToFileOffset:start];
            unsigned long long remaining = end-start+1;
            while (remaining) {
                @autoreleasepool {
                    NSData *data = [file readDataOfLength:(NSUInteger)MIN(remaining,256*1024)];
                    if (!data.length) break;
                    __block BOOL stopped = NO;
                    dispatch_sync(dispatch_get_main_queue(), ^{ stopped=[self.stoppedTasks containsObject:task]; if (!stopped) [task didReceiveData:data]; });
                    if (stopped) { [file closeFile]; return; }
                    remaining -= data.length;
                }
            }
            [file closeFile];
            dispatch_async(dispatch_get_main_queue(), ^{ if (![self.stoppedTasks containsObject:task]) [task didFinish]; });
        } @catch (NSException *exception) {
            (void)exception;
            [file closeFile];
            dispatch_async(dispatch_get_main_queue(), ^{ if (![self.stoppedTasks containsObject:task]) [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotDecodeContentData userInfo:nil]]; });
        }
    });
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task { [self.stoppedTasks addObject:task]; }
@end

int clawtab_nfn_run(const char *html, const unsigned char *iconBytes, size_t iconLength, NfnCallback handler) {
    @autoreleasepool {
        if (@available(macOS 12.0, *)) {} else { return 1; }
        if (!NSThread.isMainThread || !NSScreen.screens.count) return 1;
        callback = handler;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSImage *icon = [[NSImage alloc] initWithData:[NSData dataWithBytes:iconBytes length:iconLength]];
        icon.size = NSMakeSize(18, 18); icon.template = YES;
        surface = [[NfnSurface alloc] initWithHTML:[NSString stringWithUTF8String:html] statusIcon:icon];
        [NSApp run];
        return 0;
    }
}
void clawtab_nfn_push(const char *json) {
    @autoreleasepool {
        NSString *copy = [NSString stringWithUTF8String:json];
        dispatch_async(dispatch_get_main_queue(), ^{
            NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[copy dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
            if ([value isKindOfClass:NSDictionary.class]) [surface push:value];
        });
    }
}
void clawtab_nfn_stop(void) { dispatch_async(dispatch_get_main_queue(), ^{ [NSApp stop:nil]; [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:NO]; }); }
void clawtab_nfn_activate(unsigned int pid) { dispatch_async(dispatch_get_main_queue(), ^{ [surface endKeyboardFocus:NO]; [surface releaseTextFocus]; [[NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid] activateWithOptions:NSApplicationActivateIgnoringOtherApps]; }); }
void clawtab_nfn_activate_clawtab(void) { dispatch_async(dispatch_get_main_queue(), ^{ [surface endKeyboardFocus:NO]; [surface releaseTextFocus]; for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"cc.clawtab"]) [app activateWithOptions:NSApplicationActivateIgnoringOtherApps]; }); }
