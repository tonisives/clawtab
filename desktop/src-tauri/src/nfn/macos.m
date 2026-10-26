#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <Intents/Intents.h>
#import <UserNotifications/UserNotifications.h>
#import <ApplicationServices/ApplicationServices.h>
#include <errno.h>
#include <stdlib.h>

typedef void (*NfnCallback)(const char *);
static NfnCallback callback;

@interface NfnPanel : NSPanel
@property BOOL textFocus;
@end
@implementation NfnPanel
- (BOOL)canBecomeKeyWindow { return self.textFocus; }
- (BOOL)canBecomeMainWindow { return NO; }
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
@property id mouseMonitor;
@property NSUInteger ticks;
@property CGFloat surfaceWidth;
@property CGFloat surfaceHeight;
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

@implementation NfnSurface
- (instancetype)initWithHTML:(NSString *)html {
    if (!(self = [super init])) return nil;
    self.settings = @{};
    self.media = [NSMutableDictionary dictionary];
    self.stoppedTasks = [NSHashTable weakObjectsHashTable];
    self.panel = [[NfnPanel alloc] initWithContentRect:NSMakeRect(0, 0, 220, 40)
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    self.panel.level = NSStatusWindowLevel;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
    self.panel.hidesOnDeactivate = NO;
    self.panel.becomesKeyOnlyIfNeeded = YES;
    self.panel.floatingPanel = YES;
    self.panel.opaque = NO;
    self.panel.backgroundColor = NSColor.clearColor;
    self.panel.hasShadow = NO;
    self.panel.releasedWhenClosed = NO;
    self.panel.title = @"ClawTab notifications";
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    [configuration.userContentController addScriptMessageHandler:self name:@"nfn"];
    [configuration setURLSchemeHandler:self forURLScheme:@"clawtab-nfn"];
    configuration.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeAll;
    self.web = [[WKWebView alloc] initWithFrame:self.panel.contentView.bounds configuration:configuration];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self;
    [self.web setValue:@NO forKey:@"drawsBackground"];
    [self.panel.contentView addSubview:self.web];
    [self.web loadHTMLString:html baseURL:[NSURL URLWithString:@"clawtab-nfn://surface/"]];
    __weak NfnSurface *weakSelf = self;
    self.timer = [NSTimer scheduledTimerWithTimeInterval:2 repeats:YES block:^(NSTimer *timer) {
        NfnSurface *self = weakSelf;
        if (!self) { [timer invalidate]; return; }
        self.ticks++;
        if (self.ticks % 3 == 0) [self refreshAuthorization];
        if ([self.settings[@"display"] isEqual:@"pointer"] && [self selectedScreen] != self.panel.screen) [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
        [self publishPlatform];
        if (![self allowsOverlay]) { [self.panel orderOut:nil]; [self releaseTextFocus]; }
    }];
    self.mouseMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown handler:^(NSEvent *event) {
        (void)event;
        NfnSurface *self = weakSelf;
        if (self.panel.visible && !NSPointInRect(NSEvent.mouseLocation, self.panel.frame)) {
            [self releaseTextFocus];
            [self.web evaluateJavaScript:@"window.nfn && window.nfn.collapse()" completionHandler:nil];
        }
    }];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(screensChanged:) name:NSApplicationDidChangeScreenParametersNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(screensChanged:) name:NSWorkspaceActiveSpaceDidChangeNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(activationChanged:) name:NSWorkspaceDidActivateApplicationNotification object:nil];
    if (NSBundle.mainBundle.bundleIdentifier) {
        [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
            (void)granted; (void)error;
            dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf refreshAuthorization]; });
        }];
    }
    [self refreshAuthorization];
    return self;
}

- (void)activationChanged:(NSNotification *)notification { [self publishPlatform]; }
- (void)screensChanged:(NSNotification *)notification {
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
    NSDictionary *state = @{@"available":@YES, @"focused":[self focusStatus],
        @"authorized":self.authorizationKnown ? @(self.authorized) : NSNull.null, @"sound_allowed":@(self.soundAllowed),
        @"frontmost_pid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier), @"user_active":@(idle < 60), @"displays":displays};
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

- (void)positionWidth:(CGFloat)width height:(CGFloat)height {
    NSScreen *screen = [self selectedScreen];
    if (!screen || width <= 0 || height <= 0) return;
    CGFloat topInset = 0;
    if (@available(macOS 12.0, *)) topInset = screen.safeAreaInsets.top;
    BOOL notch = [self.settings[@"placement"] isEqual:@"notch"] && topInset > 0;
    NSRect available = screen.visibleFrame;
    CGFloat w = MIN(width, available.size.width - 32), h = MIN(height, available.size.height - 32);
    CGFloat x = notch ? NSMidX(screen.frame) - w / 2 : NSMaxX(available) - w - MIN(384, available.size.width / 3);
    x = MAX(NSMinX(available) + 16, MIN(x, NSMaxX(available) - w - 16));
    CGFloat y = notch ? NSMaxY(screen.frame) - topInset - h : NSMaxY(available) - h - 12;
    [self.panel setFrame:NSMakeRect(x, y, w, h) display:YES];
    if (self.ready) [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.nfn.setPlacement('%@')", notch ? @"notch" : @"right"] completionHandler:nil];
}

- (void)releaseTextFocus {
    if (!self.panel.textFocus) return;
    self.panel.textFocus = NO;
    [self.panel makeFirstResponder:nil];
    [self.panel resignKeyWindow];
    if (self.panel.visible) { [self.panel orderOut:nil]; if ([self allowsOverlay]) [self.panel orderFrontRegardless]; }
}

- (void)push:(NSDictionary *)value {
    if ([value[@"type"] isEqual:@"snapshot"]) {
        self.snapshot = value;
        self.settings = value[@"settings"] ?: @{};
        [self.media removeAllObjects];
        for (NSDictionary *record in value[@"records"]) {
            NSArray *media = record[@"request"][@"media"];
            for (NSUInteger i=0; i<media.count; i++) {
                NSString *src = media[i][@"src"];
                if ([src hasPrefix:@"/"]) self.media[[NSString stringWithFormat:@"/%@/%lu",record[@"id"],(unsigned long)i]] = src;
            }
        }
        [self requestFocusIfNeeded];
        if (![value[@"visible"] boolValue] || ![self allowsOverlay]) { [self.panel orderOut:nil]; [self releaseTextFocus]; }
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
    if (self.snapshot) [self push:self.snapshot];
    [self publishPlatform];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:NSDictionary.class] || !message.frameInfo.mainFrame) return;
    NSDictionary *value = message.body;
    NSString *operation = value[@"native"];
    if ([operation isEqual:@"surface"]) {
        self.surfaceWidth = [value[@"width"] doubleValue]; self.surfaceHeight = [value[@"height"] doubleValue];
        if (self.surfaceWidth < 1 || self.surfaceHeight < 1) { [self.panel orderOut:nil]; [self releaseTextFocus]; return; }
        [self positionWidth:self.surfaceWidth height:self.surfaceHeight];
        if ([self.snapshot[@"visible"] boolValue] && [self allowsOverlay]) [self.panel orderFrontRegardless];
    } else if ([operation isEqual:@"text_focus"]) {
        if ([value[@"active"] boolValue]) { self.panel.textFocus = YES; [self.panel makeKeyWindow]; [self.panel makeFirstResponder:self.web]; }
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

int clawtab_nfn_run(const char *html, NfnCallback handler) {
    @autoreleasepool {
        if (@available(macOS 12.0, *)) {} else { return 1; }
        if (!NSThread.isMainThread || !NSScreen.screens.count) return 1;
        callback = handler;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        surface = [[NfnSurface alloc] initWithHTML:[NSString stringWithUTF8String:html]];
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
void clawtab_nfn_activate(unsigned int pid) { dispatch_async(dispatch_get_main_queue(), ^{ [surface releaseTextFocus]; [[NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid] activateWithOptions:NSApplicationActivateIgnoringOtherApps]; }); }
void clawtab_nfn_activate_clawtab(void) { dispatch_async(dispatch_get_main_queue(), ^{ [surface releaseTextFocus]; for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"cc.clawtab"]) [app activateWithOptions:NSApplicationActivateIgnoringOtherApps]; }); }
