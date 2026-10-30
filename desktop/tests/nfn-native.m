// Foreground visual smoke test. No daemon, job, or user preferences are changed.
// clang -fobjc-arc -fblocks nfn-native.m -framework AppKit -framework WebKit
//   -framework Intents -framework UserNotifications -framework ApplicationServices -framework Carbon
//   -o /tmp/clawtab-nfn-native
// Generate the HTML with nfn-fixture.mjs FILE --native, then pass FILE here.
// --right checks the fallback position; --geometry-only skips keyboard focus.
// --notch-geometry checks a cached 220 x 38 cutout when no built-in screen is connected.
#import "../src-tauri/src/nfn/macos.m"

static BOOL loaded;
static BOOL platformReceived;
static NSUInteger attempts;
static pid_t previousApplication;
static BOOL positionSaved;
static NSUInteger hintToggles;
static NSDictionary *focusRecord;
static NSMutableArray<NSString *> *focusOperations;

static void verifyIdleSignals(void) {
    [surface powerChanged:[NSNotification notificationWithName:NSWorkspaceScreensDidSleepNotification object:nil]];
    NSDictionary *sleeping = [NSJSONSerialization JSONObjectWithData:[surface.lastPlatform dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![sleeping[@"screen_sleeping"] boolValue] || [sleeping[@"user_active"] boolValue]) { fprintf(stderr, "Screen sleep must mark the Mac idle\n"); exit(1); }
    [surface powerChanged:[NSNotification notificationWithName:NSWorkspaceScreensDidWakeNotification object:nil]];
    [surface lockChanged:[NSNotification notificationWithName:@"com.apple.screenIsLocked" object:nil]];
    NSDictionary *locked = [NSJSONSerialization JSONObjectWithData:[surface.lastPlatform dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![locked[@"screen_locked"] boolValue] || [locked[@"user_active"] boolValue]) { fprintf(stderr, "Screen lock must mark the Mac idle\n"); exit(1); }
    [surface lockChanged:[NSNotification notificationWithName:@"com.apple.screenIsUnlocked" object:nil]];
    printf("Idle signal checks passed: screen sleep, wake, lock, and unlock.\n");
}

static void waitForSettledSurface(NSUInteger attempt, void (^finish)(void)) {
    NSString *script = @"document.querySelector('h1')?.textContent === 'Notification layout test' && document.querySelector('#surface').getAnimations().length === 0";
    [surface.web evaluateJavaScript:script completionHandler:^(id settled, NSError *error) {
        if (!error && [settled boolValue]) { finish(); return; }
        if (attempt >= 100) { fprintf(stderr, "Notification opening animation did not settle\n"); exit(1); }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 20), dispatch_get_main_queue(), ^{ waitForSettledSurface(attempt + 1, finish); });
    }];
}

static void saveSurfaceSnapshot(NSString *path, void (^finish)(void)) {
    [surface.web evaluateJavaScript:@"(() => { const r = document.querySelector('#surface').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()" completionHandler:^(id bounds, NSError *error) {
        if (error || ![bounds isKindOfClass:NSArray.class]) { fprintf(stderr, "Could not measure notification screenshot\n"); exit(1); }
        WKSnapshotConfiguration *configuration = [WKSnapshotConfiguration new];
        configuration.rect = NSIntersectionRect(surface.web.bounds, NSMakeRect([bounds[0] doubleValue] - shadowInset, [bounds[1] doubleValue], [bounds[2] doubleValue] + shadowInset * 2, [bounds[3] doubleValue] + shadowBottom));
        [surface.web takeSnapshotWithConfiguration:configuration completionHandler:^(NSImage *image, NSError *snapshotError) {
            if (snapshotError || !image) { fprintf(stderr, "Could not capture notification screenshot\n"); exit(1); }
            NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
            finish();
        }];
    }];
}

static void sendResizePointer(NSEventType type, NSPoint screenPoint) {
    NSEvent *event = [NSEvent mouseEventWithType:type location:[surface.panel convertPointFromScreen:screenPoint] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil eventNumber:1 clickCount:1 pressure:type == NSEventTypeLeftMouseUp ? 0 : 1];
    [NSApp sendEvent:event];
}

static void waitForHoverRouting(NSUInteger attempt, BOOL (^ready)(void), void (^retry)(NSUInteger), void (^finish)(void)) {
    if (ready() || attempt >= 15) { finish(); return; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), ^{
        if (retry) retry(attempt);
        waitForHoverRouting(attempt + 1, ready, retry, finish);
    });
}

// Inactive panels can receive hover through the global monitor instead of WebKit.
// Check WindowServer delivery and its displayed cursor, independent of that route.
static void verifyNativeResizeHover(NSPoint point, void (^finish)(void)) {
    BOOL key = surface.panel.isKeyWindow;
    BOOL keyboard = surface.panel.keyboardFocus, text = surface.panel.textFocus;
    pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSCursor *(^original)(NSEvent *) = surface.web.resizeCursor;
    __block NSUInteger tracked = 0;
    __block NSUInteger localMoves = 0, globalMoves = 0;
    __block NSUInteger deliveredMoves = 0;
    __block NSString *delivery = @"none";
    void (^record)(NSEvent *) = ^(NSEvent *event) {
        CGEventRef cg = event.CGEvent;
        CGPoint location = cg ? CGEventGetLocation(cg) : CGPointMake(-1,-1);
        CGFloat desktopTop = NSMaxY(NSScreen.screens.firstObject.frame);
        BOOL expectedPoint = fabs(location.x-point.x) <= 1.1 && fabs(desktopTop-location.y-point.y) <= .5;
        if (cg && expectedPoint && CGEventGetIntegerValueField(cg,kCGEventSourceUserData) == 0x4e464e43
            && CGEventGetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointer) == surface.panel.windowNumber
            && CGEventGetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent) == surface.panel.windowNumber) deliveredMoves++;
        delivery = [NSString stringWithFormat:@"window=%ld under=%lld handler=%lld point=%@", (long)event.window.windowNumber,
            cg ? CGEventGetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointer) : -1,
            cg ? CGEventGetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent) : -1,
            NSStringFromPoint(NSEvent.mouseLocation)];
    };
    id localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskMouseMoved handler:^NSEvent *(NSEvent *event) { localMoves++; record(event); return event; }];
    id globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskMouseMoved handler:^(NSEvent *event) { globalMoves++; record(event); }];
    surface.web.resizeCursor = ^NSCursor *(NSEvent *event) { tracked++; return original(event); };
    CGFloat desktopTop = NSMaxY(NSScreen.screens.firstObject.frame);
    void (^move)(CGFloat) = ^(CGFloat dx) {
        CGEventRef event = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGPointMake(point.x + dx, desktopTop - point.y), kCGMouseButtonLeft);
        CGEventSetIntegerValueField(event,kCGEventSourceUserData,0x4e464e43);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    };
    [NSCursor.arrowCursor set];
    move(-1);
    waitForHoverRouting(0, ^BOOL { return !surface.panel.ignoresMouseEvents; }, nil, ^{
        if (surface.panel.ignoresMouseEvents) { fprintf(stderr, "Passive hover did not enable mouse routing\n"); exit(1); }
        move(0);
        waitForHoverRouting(0, ^BOOL { return deliveredMoves >= 2; }, ^(NSUInteger attempt) { move(attempt % 2 ? 0 : -1); }, ^{
            surface.web.resizeCursor = original;
            [NSEvent removeMonitor:localMonitor];
            [NSEvent removeMonitor:globalMonitor];
            fprintf(stderr,"Hover delivery: panel=%ld target=%s actual=%s frame=%s passthrough=%d local=%lu global=%lu last=%s\n",(long)surface.panel.windowNumber,NSStringFromPoint(point).UTF8String,NSStringFromPoint(NSEvent.mouseLocation).UTF8String,NSStringFromRect(surface.panel.frame).UTF8String,surface.panel.ignoresMouseEvents,(unsigned long)localMoves,(unsigned long)globalMoves,delivery.UTF8String);
            NSCursor *expected = NSCursor.resizeLeftRightCursor;
            if (@available(macOS 15.0,*)) expected = [NSCursor frameResizeCursorFromPosition:NSCursorFrameResizePositionBottomRight inDirections:NSCursorFrameResizeDirectionsAll];
            NSCursor *displayed = NSCursor.currentSystemCursor;
            NSBitmapImageRep *actualImage = displayed ? [NSBitmapImageRep imageRepWithData:displayed.image.TIFFRepresentation] : nil;
            NSBitmapImageRep *expectedImage = [NSBitmapImageRep imageRepWithData:expected.image.TIFFRepresentation];
            BOOL exactCursor = actualImage && NSEqualPoints(displayed.hotSpot,expected.hotSpot)
                && [[actualImage representationUsingType:NSBitmapImageFileTypePNG properties:@{}] isEqual:[expectedImage representationUsingType:NSBitmapImageFileTypePNG properties:@{}]];
            BOOL pointerAtCorner = fabs(NSEvent.mouseLocation.x-point.x) <= 1.1 && fabs(NSEvent.mouseLocation.y-point.y) <= .5;
            if (deliveredMoves < 2 || !pointerAtCorner || !exactCursor || surface.panel.isKeyWindow != key
                || surface.panel.keyboardFocus != keyboard || surface.panel.textFocus != text
                || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != foreground) {
                fprintf(stderr, "OS-routed passive corner hover failed: delivered=%lu tracking=%lu system_cursor=%s point=%d key=%d->%d\n", (unsigned long)deliveredMoves,(unsigned long)tracked,exactCursor ? "native diagonal" : "mismatch",pointerAtCorner,key,surface.panel.isKeyWindow); exit(1);
            }
            printf("OS-routed passive hover: %lu verified panel events, %lu WebKit callbacks, displayed native diagonal, key=%d->%d.\n",(unsigned long)deliveredMoves,(unsigned long)tracked,key,surface.panel.isKeyWindow);
            [surface.web evaluateJavaScript:@"document.querySelector('#surface').dataset.pointerActive === 'true' && document.querySelector('#surface').dataset.keyboardActive === 'false' && getComputedStyle(document.querySelector('.brand img')).filter === 'none' && getComputedStyle(document.querySelector('.todo-ring')).filter === 'none' && !document.querySelector('.keyboard-hint')" completionHandler:^(id colored, NSError *error) {
                if (error || ![colored boolValue]) { fprintf(stderr, "Native hover did not color title buttons while preserving passive keyboard state\n"); exit(1); }
                saveSurfaceSnapshot(surface.notchPlacement ? @"/tmp/clawtab-nfn-hover-notch.png" : @"/tmp/clawtab-nfn-hover-right.png", finish);
            }];
        });
    });
}

static void verifyResizeCorners(void (^finish)(void)) {
    NSRect before = [surface surfaceFrame];
    BOOL notch = surface.notchPlacement;
    BOOL keyBefore = surface.panel.isKeyWindow;
    pid_t foregroundBefore = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    fprintf(stderr, "Corner start: key=%d text=%d keyboard=%d foreground=%d\n", keyBefore, surface.panel.textFocus, surface.panel.keyboardFocus, foregroundBefore);
    NSString *script = @"(() => { const host = document.querySelector('#surface').getBoundingClientRect(); if (host.left < 63 || host.right > innerWidth - 63 || host.bottom > innerHeight - 79) throw Error('Shadow extends outside the native canvas'); const handle = document.querySelector('.resize-se'); if (!handle || handle.hidden) return null; const r = handle.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]; })()";
    [surface.web evaluateJavaScript:script completionHandler:^(id point, NSError *error) {
        if (error || ![point isKindOfClass:NSArray.class]) { fprintf(stderr, "Bottom-right resize handle is unavailable\n"); exit(1); }
        CGFloat y = [point[1] doubleValue];
        NSPoint location = [surface.web convertPoint:NSMakePoint([point[0] doubleValue], surface.web.isFlipped ? y : surface.web.bounds.size.height - y) toView:nil];
        NSPoint start = [surface.panel convertPointToScreen:location], end = NSMakePoint(start.x + 16, start.y);
        verifyNativeResizeHover(start, ^{
        sendResizePointer(NSEventTypeLeftMouseDown, start);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), ^{
            sendResizePointer(NSEventTypeLeftMouseDragged, end);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), ^{
                sendResizePointer(NSEventTypeLeftMouseUp, end);
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), ^{
                    NSRect after = [surface surfaceFrame];
                    fprintf(stderr, "Corner end: key=%d text=%d keyboard=%d foreground=%d\n", surface.panel.isKeyWindow, surface.panel.textFocus, surface.panel.keyboardFocus, NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
                    if (surface.panel.isKeyWindow != keyBefore || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != foregroundBefore) { fprintf(stderr, "Corner dragging changed keyboard focus or the foreground app\n"); exit(1); }
                    CGFloat growth = notch ? 32 : 16;
                    if (fabs(after.size.width - before.size.width - growth) > 1
                        || fabs(NSMaxY(after) - NSMaxY(before)) > 1
                        || fabs(NSMaxX(after) - NSMaxX(before) - 16) > 1
                        || (!notch && fabs(NSMinX(after) - NSMinX(before)) > 1)) {
                        fprintf(stderr, "Right corner dragging does not preserve its opposite edge\n"); exit(1);
                    }
                    saveSurfaceSnapshot(notch ? @"/tmp/clawtab-nfn-resize-corner-notch.png" : @"/tmp/clawtab-nfn-resize-corner-right.png", ^{
                    [surface.web evaluateJavaScript:@"document.querySelector('.resize-se').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}))" completionHandler:^(id result, NSError *restoreError) {
                        if (restoreError) { fprintf(stderr, "Could not restore resized width\n"); exit(1); }
                        waitForSettledSurface(0, ^{
                            printf("Native corner resize checks passed: passive resize cursor, real bottom-right pointer drag, fixed opposite edge, top anchor, and reverse resize.\n");
                            finish();
                        });
                    }];
                    });
                });
            });
        });
        });
    }];
}

static void verifyMenuLayout(void (^finish)(void)) {
    NSDictionary *original = surface.snapshot;
    NSMutableDictionary *snapshot = [NSJSONSerialization JSONObjectWithData:[NSJSONSerialization dataWithJSONObject:original options:0 error:nil] options:NSJSONReadingMutableContainers error:nil];
    NSMutableDictionary *request = snapshot[@"records"][0][@"request"];
    request[@"template"] = @"update";
    request[@"body"] = @"The agent finished its turn and is ready for your next message.";
    request[@"actions"] = @[@{@"id":@"focus", @"label":@"Open session", @"kind":@"focus"}, @{@"id":@"acknowledge", @"label":@"Got it", @"kind":@"choice"}];
    snapshot[@"arrival"] = snapshot[@"records"][0][@"id"];
    NSString *position = surface.notchPlacement ? @"notch" : @"right";
    [surface.web evaluateJavaScript:@"window.nfn.collapse()" completionHandler:^(id value, NSError *error) {
        [surface push:snapshot];
        waitForSettledSurface(0, ^{
            CGFloat compactHeight = surface.surfaceHeight;
            if (surface.surfaceWidth < 520 || compactHeight < 280) { fprintf(stderr, "Short notification is smaller than its minimum size\n"); exit(1); }
            saveSurfaceSnapshot([NSString stringWithFormat:@"/tmp/clawtab-nfn-short-%@.png", position], ^{
                [surface.web evaluateJavaScript:@"document.querySelector('[aria-label=\"Notification options\"]').click()" completionHandler:^(id result, NSError *menuError) {
                    if (menuError) { fprintf(stderr, "Could not open notification options\n"); exit(1); }
                    waitForSettledSurface(0, ^{
                        [surface.web evaluateJavaScript:@"(() => { const host = document.querySelector('#surface').getBoundingClientRect(), menu = document.querySelector('.menu-panel'), bounds = menu.getBoundingClientRect(); return bounds.bottom <= host.bottom - 8 && bounds.right <= host.right && menu.scrollHeight <= menu.clientHeight + 1; })()" completionHandler:^(id fits, NSError *fitError) {
                            if (fitError || ![fits boolValue] || surface.surfaceHeight <= compactHeight) { fprintf(stderr, "Options do not fit inside the expanded native notification\n"); exit(1); }
                            saveSurfaceSnapshot([NSString stringWithFormat:@"/tmp/clawtab-nfn-options-%@.png", position], ^{
                                [surface.web evaluateJavaScript:@"window.nfn.collapse()" completionHandler:^(id closed, NSError *closeError) {
                                    [surface push:original];
                                    waitForSettledSurface(0, ^{
                                        printf("Native menu checks passed: larger short cards, all option rows visible, window expands to fit.\n");
                                        finish();
                                    });
                                }];
                            });
                        }];
                    });
                }];
            });
        });
    }];
}

static void verifyPresentationLifetime(void (^finish)(void)) {
    NSMutableDictionary *snapshot = [surface.snapshot mutableCopy];
    snapshot[@"visible"] = @NO;
    snapshot[@"arrival"] = NSNull.null;
    NSMutableDictionary *settings = [surface.settings mutableCopy];
    settings[@"focus"] = @"follow";
    snapshot[@"settings"] = settings;
    surface.authorizationKnown = YES;
    surface.authorized = NO;
    [surface push:snapshot];
    if (!surface.panel.visible || !surface.notificationsVisible) { fprintf(stderr, "A platform update immediately hid a displayed card\n"); exit(1); }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
        [surface.web evaluateJavaScript:@"Boolean(document.querySelector('.card')) && !document.querySelector('#surface').classList.contains('empty')" completionHandler:^(id kept, NSError *error) {
            if (error || ![kept boolValue] || !surface.panel.visible) { fprintf(stderr, "A displayed card disappeared after Focus delivery changed\n"); exit(1); }
            [surface.web evaluateJavaScript:@"window.nfn.collapse()" completionHandler:^(id value, NSError *collapseError) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                    if (collapseError || surface.panel.visible || surface.notificationsVisible) { fprintf(stderr, "Explicit collapse did not release the displayed card\n"); exit(1); }
                    printf("Native card lifetime checks passed: displayed cards survive Focus delivery changes and close on explicit collapse.\n");
                    finish();
                });
            }];
        }];
    });
}

static void verifyEmptyBarToggle(void (^finish)(void)) {
    NSString *script = @"document.querySelector('.bar-toggle').click(); const historyOpened = document.querySelector('[data-history=true]')?.getAttribute('aria-selected') === 'true'; document.querySelector('.bar-toggle').click(); historyOpened && document.querySelector('#surface').classList.contains('pill')";
    [surface.web evaluateJavaScript:script completionHandler:^(id kept, NSError *error) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_main_queue(), ^{
            if (error || ![kept boolValue] || !surface.panel.visible || !surface.notificationsVisible) { fprintf(stderr, "Collapsing empty History hid the notification bar\n"); exit(1); }
            [surface.statusItem.button performClick:nil];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_main_queue(), ^{
                if (surface.panel.visible || surface.notificationsVisible) { fprintf(stderr, "Second menu icon click did not hide the empty bar\n"); exit(1); }
                finish();
            });
        });
    }];
}

static void verifyInlineSettings(void (^finish)(void)) {
    [surface.web evaluateJavaScript:@"window.nfn.collapse()" completionHandler:^(id value, NSError *error) {
        if (error) { fprintf(stderr, "Could not reset the notification fixture\n"); exit(1); }
        NSMutableDictionary *snapshot = [surface.snapshot mutableCopy];
        snapshot[@"visible"] = @NO; snapshot[@"records"] = @[]; snapshot[@"pending_count"] = @0;
        snapshot[@"settings"] = @{@"delivery":@"native", @"focus":@"follow", @"placement":@"right", @"display":@"primary"};
        [surface push:snapshot];
        NSStatusItem *item = surface.statusItem;
        if (!item || !item.button.image.isTemplate || item.menu || item.button.action != @selector(openNotifications:) || ![item.button.accessibilityLabel isEqual:@"ClawTab notifications"]) {
            fprintf(stderr, "Daemon menu bar icon is not a direct notification button\n"); exit(1);
        }
        [surface push:snapshot];
        if (surface.statusItem != item) { fprintf(stderr, "Snapshot recreated the menu bar icon\n"); exit(1); }
        NSMutableDictionary *settings = [snapshot[@"settings"] mutableCopy];
        settings[@"menu_bar_icon"] = @NO; snapshot[@"settings"] = settings;
        [surface push:snapshot];
        if (surface.statusItem) { fprintf(stderr, "Menu bar icon stayed visible after being disabled\n"); exit(1); }
        settings[@"menu_bar_icon"] = @YES;
        [surface push:snapshot];
        if (!surface.statusItem) { fprintf(stderr, "Menu bar icon did not return after being enabled\n"); exit(1); }
        [surface.statusItem.button performClick:nil];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_main_queue(), ^{
            [surface.web evaluateJavaScript:@"document.querySelector('#surface').classList.contains('pill') && !document.querySelector('.card, .queue')" completionHandler:^(id opened, NSError *openError) {
                if (openError || ![opened boolValue] || !surface.panel.visible || !surface.notificationsVisible || surface.surfaceWidth > 225 || surface.surfaceHeight > 44) { fprintf(stderr, "Empty menu bar notifications did not open as a collapsed bar with native delivery\n"); exit(1); }
                verifyEmptyBarToggle(^{
                    [surface push:@{@"type":@"settings"}];
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), dispatch_get_main_queue(), ^{
                        [surface.web evaluateJavaScript:@"Boolean(document.querySelector('.notification-settings'))" completionHandler:^(id visible, NSError *viewError) {
                            if (viewError || ![visible boolValue] || !surface.panel.visible || !surface.settingsVisible) {
                                fprintf(stderr, "Inline settings did not open with no cards and native delivery\n"); exit(1);
                            }
                            [surface.web evaluateJavaScript:@"document.querySelector('.close-bar').click()" completionHandler:^(id closed, NSError *closeError) {
                                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_main_queue(), ^{
                                    if (closeError || surface.settingsVisible || surface.panel.visible) { fprintf(stderr, "Closing empty settings left the panel visible\n"); exit(1); }
                                    printf("Native inline settings checks passed: opens with no pending cards or overlay delivery, then closes completely.\n");
                                    printf("Native menu bar checks passed: icon persists across refreshes, toggles immediately, and opens the notification window directly with native delivery.\n");
                                    finish();
                                });
                            }];
                        }];
                    });
                });
            }];
        });
    }];
}

static void verifyDragging(void (^finish)(void)) {
    [surface releaseTextFocus];
    pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSRect before = [surface surfaceFrame];
    surface.dragPointerOrigin = NSMakePoint(NSMaxX(before) - 20, NSMaxY(before) - 20);
    [surface drag:@{@"phase":@"start"}];
    NSPoint pointer = NSMakePoint(surface.dragPointerOrigin.x - 70, surface.dragPointerOrigin.y - 40);
    NSEvent *move = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:[surface.panel convertPointFromScreen:pointer] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
    [NSApp sendEvent:move];
    NSRect moved = [surface surfaceFrame];
    if (fabs(NSMaxX(before) - NSMaxX(moved) - 70) > 1 || surface.notchPlacement) {
        fprintf(stderr, "Dragging did not move the panel or detach the notch\n"); exit(1);
    }
    NSEvent *up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:[surface.panel convertPointFromScreen:pointer] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil eventNumber:1 clickCount:1 pressure:0];
    [NSApp sendEvent:up];
    NSRect dropped = surface.panel.frame;
    [surface positionWidth:surface.surfaceWidth height:surface.surfaceHeight];
    if (!positionSaved || surface.dragging || ![surface.settings[@"placement"] isEqual:@"custom"] || !NSEqualRects(dropped, surface.panel.frame)) {
        fprintf(stderr, "Dropped position was not saved or preserved\n"); exit(1);
    }
    if (surface.panel.isKeyWindow || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != foreground) {
        fprintf(stderr, "Dragging activated the notification panel or changed the foreground app: key=%d text=%d keyboard=%d foreground=%d expected=%d\n", surface.panel.isKeyWindow, surface.panel.textFocus, surface.panel.keyboardFocus, NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, foreground); exit(1);
    }
    printf("Native dragging checks passed: native mouse movement and release, unchanged focus, notch detach and saved drop coordinates.\n");
    finish();
}

static void verifyMessageFocus(void (^finish)(void)) {
    clawtab_nfn_activate(previousApplication);
    NSString *setup = @"window.nfn.collapse(); const record = window.fixture.record('cli-focus'); record.status = 'resolved'; record.dismissed_at = Date.now(); record.request.title = 'Focused history message'; JSON.stringify(record);";
    [surface.web evaluateJavaScript:setup completionHandler:^(id result, NSError *error) {
        if (error || ![result isKindOfClass:NSString.class]) { fprintf(stderr, "Could not prepare message focus fixture\n"); exit(1); }
        focusRecord = [NSJSONSerialization JSONObjectWithData:[result dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        focusOperations = [NSMutableArray array];
        NSDictionary *record = @{@"id":@"cli-focus", @"request":@{@"media":@[@{@"src":@"/tmp/focus-attachment.png"}]}};
        NSDictionary *event = @{@"type":@"open_record", @"id":@"cli-focus", @"record":record, @"focus":@YES};
        [surface push:event];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
            [surface push:event];
            [surface push:surface.snapshot];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                NSString *check = @"document.querySelector('h1')?.textContent === 'Focused history message' && document.activeElement === document.querySelector('#surface')";
                [surface.web evaluateJavaScript:check completionHandler:^(id opened, NSError *checkError) {
                    NSSet *allowed = [NSSet setWithArray:@[@"get", @"read", @"context"]];
                    BOOL inspected = [focusOperations containsObject:@"get"] && [[NSSet setWithArray:focusOperations] isSubsetOfSet:allowed];
                    if (checkError || ![opened boolValue] || !inspected || !surface.panel.isKeyWindow || !surface.panel.keyboardFocus || !surface.notificationsVisible || ![surface.media[@"/cli-focus/0"] isEqual:@"/tmp/focus-attachment.png"]) {
                        fprintf(stderr, "CLI message focus did not retain the history card, keyboard focus, or attachment\n"); exit(1);
                    }
                    [surface toggleKeyboardFocus];
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                        if (surface.panel.isKeyWindow || surface.panel.keyboardFocus) { fprintf(stderr, "Focused message did not release keyboard focus\n"); exit(1); }
                        printf("Message focus checks passed: history lookup, repeated focus, keyboard entry and exit, attachment retained across snapshots, no response or dismissal.\n");
                        [surface push:@{@"type":@"latest"}];
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), finish);
                    });
                }];
            });
        });
    }];
}

static void verifyKeyboardControl(void (^finish)(void)) {
    clawtab_nfn_activate(previousApplication);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
        [surface toggleKeyboardFocus];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
            if (!surface.panel.keyboardFocus || !surface.panel.isKeyWindow) { fprintf(stderr,"Global keyboard entry did not focus panel\n"); exit(1); }
            [surface releaseTextFocus];
            if (!surface.panel.isKeyWindow) { fprintf(stderr,"Field blur released keyboard session\n"); exit(1); }
            NSTimeInterval at = NSProcessInfo.processInfo.systemUptime;
            for (NSUInteger i = 0; i < 4; i++) {
                NSEvent *event = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:i % 2 ? 0 : NSEventModifierFlagOption timestamp:at + i * .04 windowNumber:surface.panel.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:kVK_Option];
                [NSApp sendEvent:event];
            }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                if (hintToggles != 1) { fprintf(stderr,"Double Option did not toggle hints exactly once (%lu)\n", (unsigned long)hintToggles); exit(1); }
                [surface.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                    if (snapshotError || !image) { fprintf(stderr,"Hint snapshot failed\n"); exit(1); }
                    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@"/tmp/clawtab-nfn-hints.png" atomically:YES];
                [surface.web evaluateJavaScript:@"(() => { const badge = [...document.querySelectorAll('.keyboard-hint')].find(b => b.dataset.target === 'Details'); if (!badge) throw Error('Details hint missing'); const host = document.getElementById('surface'); if (host.dataset.keyboardActive !== 'true' || getComputedStyle(host).outlineStyle !== 'none' || getComputedStyle(document.querySelector('.brand img')).filter !== 'none' || getComputedStyle(document.querySelector('.todo-ring')).filter !== 'none') throw Error('Active bar appearance did not follow native keyboard focus'); for (const key of badge.textContent) host.dispatchEvent(new KeyboardEvent('keydown', {key:key.toLowerCase(),bubbles:true,cancelable:true})); return document.getElementById('surface').classList.contains('details-open'); })()" completionHandler:^(id activated, NSError *error) {
                    if (error || ![activated boolValue]) { fprintf(stderr,"Typing a hint did not activate Details: %s\n", error.description.UTF8String); exit(1); }
                    [surface toggleKeyboardFocus];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                    if (surface.panel.keyboardFocus || surface.panel.isKeyWindow) { fprintf(stderr,"Second hotkey did not release panel\n"); exit(1); }
                    printf("Keyboard control checks passed: focus entry, field blur lease, double Option, and second-press exit.\n");
                    [surface push:@{@"type":@"latest"}];
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{ verifyMessageFocus(finish); });
                });
                }];
                }];
            });
        });
    });
}

static void verifyEditing(void (^finish)(void)) {
    [surface.web evaluateJavaScript:@"const input = document.querySelector('textarea'); input.value = 'Reply shortcut check'; input.focus(); input.setSelectionRange(input.value.length, input.value.length)" completionHandler:^(id value, NSError *error) {
        NSEvent *selectAll = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];
        if (error || ![surface.panel performKeyEquivalent:selectAll]) { fprintf(stderr,"Command-A was not handled by the reply field\n"); exit(1); }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), ^{
            [surface.web evaluateJavaScript:@"(() => { const input = document.querySelector('textarea'); return input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value === 'Reply shortcut check'; })()" completionHandler:^(id selected, NSError *selectionError) {
                if (selectionError || ![selected boolValue]) { fprintf(stderr,"Command-A did not select the complete reply\n"); exit(1); }
                [surface releaseTextFocus];
                if (surface.panel.canBecomeKeyWindow || surface.panel.textFocus || [surface.panel performKeyEquivalent:selectAll]) { fprintf(stderr,"Editing commands remain active after reply focus was released\n"); exit(1); }
                finish();
            }];
        });
    }];
}

static void clickWebPoint(NSArray *point) {
    CGFloat y = [point[1] doubleValue];
    NSPoint location = [surface.web convertPoint:NSMakePoint([point[0] doubleValue], surface.web.isFlipped ? y : surface.web.bounds.size.height - y) toView:nil];
    for (NSNumber *type in @[@(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp)]) {
        NSEvent *event = [NSEvent mouseEventWithType:type.unsignedIntegerValue location:location modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil eventNumber:1 clickCount:1 pressure:type.unsignedIntegerValue == NSEventTypeLeftMouseDown ? 1 : 0];
        if (![surface.web acceptsFirstMouse:event]) { fprintf(stderr, "Notification web view rejects the activating click\n"); exit(1); }
        [NSApp sendEvent:event];
    }
}

static void verifyReplyFirstClick(void (^finish)(void)) {
    [surface releaseTextFocus];
    [surface.web evaluateJavaScript:@"(() => { window.firstClickCount = 0; const input = document.querySelector('textarea'); input.addEventListener('pointerdown', () => window.firstClickCount++); const r = input.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()" completionHandler:^(id point, NSError *error) {
        if (error || ![point isKindOfClass:NSArray.class] || surface.panel.isKeyWindow) { fprintf(stderr, "Could not prepare inactive reply click\n"); exit(1); }
        clickWebPoint(point);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
            [surface.web evaluateJavaScript:@"window.firstClickCount === 1 && document.activeElement === document.querySelector('textarea') && document.querySelector('#surface').dataset.keyboardActive === 'true' && getComputedStyle(document.querySelector('.brand img')).filter === 'none' && getComputedStyle(document.querySelector('.todo-ring')).filter === 'none'" completionHandler:^(id received, NSError *clickError) {
                if (clickError || ![received boolValue]) { fprintf(stderr, "First native click did not reach and focus the reply field\n"); exit(1); }
                printf("Native first-click check passed: reply receives the activating click and title bar icons regain color.\n");
                finish();
            }];
        });
    }];
}

static void verifyFirstClick(void (^finish)(void)) {
    pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    [surface.web evaluateJavaScript:@"(() => { window.passiveClickCount = 0; const title = document.querySelector('h1'); title.addEventListener('pointerdown', () => window.passiveClickCount++); const r = title.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()" completionHandler:^(id point, NSError *error) {
        if (error || ![point isKindOfClass:NSArray.class]) { fprintf(stderr, "Could not measure passive click target\n"); exit(1); }
        clickWebPoint(point);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
            [surface.web evaluateJavaScript:@"window.passiveClickCount === 1 && document.querySelector('#surface').dataset.keyboardActive === 'false' && getComputedStyle(document.querySelector('.brand img')).filter === (document.querySelector('#surface').dataset.pointerActive === 'true' ? 'none' : 'grayscale(1)')" completionHandler:^(id received, NSError *clickError) {
                if (clickError || ![received boolValue] || surface.panel.isKeyWindow || surface.panel.textFocus || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != foreground) {
                    fprintf(stderr, "Ordinary first click was lost or activated the notification panel\n"); exit(1);
                }
                printf("Native passive click check passed: first click delivered without changing key window or foreground app.\n");
                verifyReplyFirstClick(finish);
            }];
        });
    }];
}

static void sampleExpansion(NSMutableArray<NSNumber *> *widths, void (^finish)(void)) {
    [surface.web evaluateJavaScript:@"document.querySelector('#surface').getBoundingClientRect().width" completionHandler:^(id width, NSError *error) {
        if (error || ![width isKindOfClass:NSNumber.class]) { fprintf(stderr, "Could not measure the notification animation\n"); exit(1); }
        [widths addObject:width];
        if (widths.count >= 10) { finish(); return; }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 20), dispatch_get_main_queue(), ^{ sampleExpansion(widths, finish); });
    }];
}

static void verifyExpansion(void (^finish)(void)) {
    NSRect compact = [surface surfaceFrame], canvas = surface.panel.frame;
    [surface.web evaluateJavaScript:@"document.querySelector('.details-toggle').click()" completionHandler:^(id value, NSError *error) {
        if (error) { fprintf(stderr,"Details did not open\n"); exit(1); }
        NSMutableArray<NSNumber *> *widths = [NSMutableArray array];
        sampleExpansion(widths, ^{
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_main_queue(), ^{
                NSRect expanded = [surface surfaceFrame];
                BOOL anchored = fabs(NSMaxY(expanded) - NSMaxY(compact)) < 1;
                BOOL fixedCanvas = NSEqualRects(canvas, surface.panel.frame);
                BOOL immediate = widths.count > 0;
                for (NSNumber *width in widths) if (fabs(width.doubleValue - expanded.size.width) > 1) immediate = NO;
                CGFloat maxHeight = [surface selectedScreen].visibleFrame.size.height * .8;
                if (expanded.size.width < 600 || expanded.size.height <= compact.size.height + 100 || expanded.size.height > maxHeight + 1 || !anchored || !immediate || !fixedCanvas) {
                    fprintf(stderr,"Expansion failed: compact=%.0fx%.0f drawn=%s expanded=%.0fx%.0f maxHeight=%.0f anchored=%d immediate=%d\n",compact.size.width,compact.size.height,widths.description.UTF8String,expanded.size.width,expanded.size.height,maxHeight,anchored,immediate); exit(1);
                }
                [surface.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                    if (snapshotError || !image) { fprintf(stderr,"Expanded snapshot failed\n"); exit(1); }
                    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@"/tmp/clawtab-nfn-expanded.png" atomically:YES];
                    finish();
                }];
            });
        });
    }];
}

static void bridge(const char *raw) {
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    NSString *operation = value[@"command"][@"op"];
    if ([operation isEqual:@"set_position"]) { positionSaved = YES; return; }
    if ([operation isEqual:@"platform"]) {
        NSDictionary *state = value[@"command"][@"state"];
        for (NSString *key in @[@"available", @"sound_allowed", @"user_active", @"screen_sleeping", @"screen_locked", @"focused", @"authorized"]) {
            id flag = state[key];
            BOOL nullable = [key isEqual:@"focused"] || [key isEqual:@"authorized"];
            if ((!flag || CFGetTypeID((__bridge CFTypeRef)flag) != CFBooleanGetTypeID()) && !(nullable && flag == NSNull.null)) {
                fprintf(stderr,"Native platform flag is not a JSON boolean: %s\n", key.UTF8String); exit(1);
            }
        }
        platformReceived = YES;
        return;
    }
    if (!value[@"token"]) return;
    NSDictionary *result = @{};
    if ([value[@"command"][@"id"] isEqual:@"cli-focus"]) {
        [focusOperations addObject:operation];
        if ([operation isEqual:@"get"] || [operation isEqual:@"read"]) result = focusRecord;
    }
    if ([operation isEqual:@"save_settings"]) { hintToggles++; NSMutableDictionary *settings = [surface.settings mutableCopy]; [settings addEntriesFromDictionary:value[@"command"][@"patch"]]; result = @{@"settings":settings}; }
    if ([operation isEqual:@"context"]) result = @{@"log":@"Review ready\nWaiting for a decision",@"models":@[],@"plugins":@[],@"source":@{}};
    clawtab_nfn_push([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:@{@"type":@"response",@"token":value[@"token"],@"value":result} options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2 || argc > 3) return 2;
        BOOL rightColumn = argc == 3 && strcmp(argv[2], "--right") == 0;
        BOOL simulatedNotch = argc == 3 && strcmp(argv[2], "--notch-geometry") == 0;
        BOOL geometryOnly = simulatedNotch || (argc == 3 && strcmp(argv[2], "--geometry-only") == 0);
        NSString *html = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[1]] encoding:NSUTF8StringEncoding error:nil];
        if (!html) return 2;
        previousApplication = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
            if (loaded) { [timer invalidate]; return; }
            if (++attempts > 100) { fprintf(stderr,"Native renderer did not load\n"); exit(1); }
            [surface.web evaluateJavaScript:@"window.fixture && JSON.stringify(window.fixture.snapshot('first'))" completionHandler:^(id value, NSError *error) {
                if (loaded || error || ![value isKindOfClass:NSString.class]) return;
                loaded = YES;
                verifyIdleSignals();
                NSMutableDictionary *snapshot = [[NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingMutableContainers error:nil] mutableCopy];
                snapshot[@"records"][0][@"request"][@"title"] = @"Notification layout test";
                snapshot[@"records"][0][@"request"][@"body"] = @"Checking notch alignment and resize animation. This temporary test closes automatically.";
                snapshot[@"settings"] = @{@"delivery":@"enhanced",@"focus":@"independent",@"placement":rightColumn ? @"right" : @"notch",@"display":@"built_in",@"preview_seconds":@8};
                if (simulatedNotch) {
                    NSScreen *screen = [surface selectedScreen];
                    surface.notchGeometry[[screen.deviceDescription[@"NSScreenNumber"] stringValue]] = @{@"inset":@38, @"width":@220, @"center":@(NSMidX(screen.frame)), @"frame":[NSValue valueWithRect:screen.frame], @"scale":@(screen.backingScaleFactor)};
                }
                [surface push:snapshot];
                [surface.web evaluateJavaScript:@"document.querySelector('#surface').dispatchEvent(new MouseEvent('mouseenter'))" completionHandler:nil];
                waitForSettledSurface(0, ^{
                    if (surface.panel.level != NSStatusWindowLevel) {
                        fprintf(stderr, "Message bar must remain above floating window borders: level=%ld expected=%ld\n", (long)surface.panel.level, (long)NSStatusWindowLevel); exit(1);
                    }
                    printf("Native overlay level check passed: status level %ld above floating borders at %ld.\n", (long)surface.panel.level, (long)NSFloatingWindowLevel);
                    BOOL nonactivating = (surface.panel.styleMask & NSWindowStyleMaskNonactivatingPanel) != 0;
                    BOOL foregroundPreserved = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == previousApplication;
                    BOOL geometry = surface.surfaceWidth >= 390 && surface.surfaceHeight > 100 && surface.surfaceHeight < 700;
                    BOOL passive = !surface.panel.canBecomeKeyWindow;
                    BOOL ignoresCycle = (surface.panel.collectionBehavior & NSWindowCollectionBehaviorIgnoresCycle) != 0;
                    NSScreen *screen = [surface selectedScreen];
                    BOOL notchSeam = YES;
                    if (@available(macOS 12.0, *)) {
                        CGFloat inset = [[surface notchForScreen:screen][@"inset"] doubleValue];
                        if (!rightColumn && inset > 0) notchSeam = fabs(NSMaxY(surface.panel.frame) - NSMaxY(screen.frame)) < 1;
                        printf("Native display: %s; measured notch: %.0f; current AppKit inset: %.0f\n", screen.localizedName.UTF8String, inset, screen.safeAreaInsets.top);
                    }
                    if (!platformReceived || !nonactivating || !foregroundPreserved || !geometry || !passive || !surface.panel.visible || !ignoresCycle || !notchSeam) {
                        fprintf(stderr,"Native panel checks failed: mask=%d foreground=%d geometry=%d passive=%d visible=%d occlusion=%lu frame=%.0fx%.0f surface=%.0fx%.0f ready=%d\n",nonactivating,foregroundPreserved,geometry,passive,surface.panel.visible,(unsigned long)surface.panel.occlusionState,surface.panel.frame.size.width,surface.panel.frame.size.height,surface.surfaceWidth,surface.surfaceHeight,surface.ready); exit(1);
                    }
                    [surface.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                        if (snapshotError || !image) { fprintf(stderr,"Native snapshot failed\n"); exit(1); }
                        NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                        [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@"/tmp/clawtab-nfn-native.png" atomically:YES];
                        if (geometryOnly) {
                            verifyExpansion(^{
                                printf("Native geometry checks passed: passive arrival, notch overlap, window cycling excluded, animated expansion and fixed top anchor.\n");
                                verifyResizeCorners(^{ verifyMenuLayout(^{ verifyDragging(^{ verifyPresentationLifetime(^{ verifyInlineSettings(^{ clawtab_nfn_stop(); }); }); }); }); });
                            });
                            return;
                        }
                        verifyFirstClick(^{
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                                if (!surface.panel.textFocus || !surface.panel.isKeyWindow) { fprintf(stderr,"Reply focus lease failed: lease=%d key=%d can-key=%d\n",surface.panel.textFocus,surface.panel.isKeyWindow,surface.panel.canBecomeKeyWindow); exit(1); }
                                verifyEditing(^{ verifyKeyboardControl(^{
                                    clawtab_nfn_activate(previousApplication);
                                    verifyExpansion(^{
                                        printf("Native checks passed: platform JSON booleans, passive panel, foreground preserved, notch overlap, window cycling excluded, reply focus, Command-A selection, animated expansion and fixed top anchor. Screenshots: /tmp/clawtab-nfn-native.png, /tmp/clawtab-nfn-expanded.png\n");
                                        verifyResizeCorners(^{ verifyMenuLayout(^{ verifyDragging(^{ verifyPresentationLifetime(^{ verifyInlineSettings(^{ clawtab_nfn_stop(); }); }); }); }); });
                                    });
                                }); });
                            });
                        });
                    }];
                });
            }];
        }];
        NSString *iconPath = [[[NSString stringWithUTF8String:__FILE__] stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"../src-tauri/icons/tray-icon.png"];
        NSData *icon = [NSData dataWithContentsOfFile:iconPath];
        if (!icon.length) { fprintf(stderr, "Missing notification menu bar icon\n"); return 1; }
        return clawtab_nfn_run(html.UTF8String, icon.bytes, icon.length, bridge);
    }
}
