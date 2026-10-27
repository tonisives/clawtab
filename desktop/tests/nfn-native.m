// Foreground visual smoke test. No daemon, job, or user preferences are changed.
// clang -fobjc-arc -fblocks nfn-native.m -framework AppKit -framework WebKit
//   -framework Intents -framework UserNotifications -framework ApplicationServices
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
        configuration.rect = NSMakeRect([bounds[0] doubleValue], [bounds[1] doubleValue], [bounds[2] doubleValue], [bounds[3] doubleValue]);
        [surface.web takeSnapshotWithConfiguration:configuration completionHandler:^(NSImage *image, NSError *snapshotError) {
            if (snapshotError || !image) { fprintf(stderr, "Could not capture notification screenshot\n"); exit(1); }
            NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
            finish();
        }];
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
    NSRect before = [surface surfaceFrame];
    [surface drag:@{@"phase":@"start"}];
    [surface drag:@{@"phase":@"move", @"dx":@(-70), @"dy":@40}];
    NSRect moved = [surface surfaceFrame];
    if (fabs(NSMaxX(before) - NSMaxX(moved) - 70) > 1 || surface.notchPlacement) {
        fprintf(stderr, "Dragging did not move the panel or detach the notch\n"); exit(1);
    }
    [surface drag:@{@"phase":@"end"}];
    NSRect dropped = surface.panel.frame;
    [surface positionWidth:surface.surfaceWidth height:surface.surfaceHeight];
    if (!positionSaved || surface.dragging || ![surface.settings[@"placement"] isEqual:@"custom"] || !NSEqualRects(dropped, surface.panel.frame)) {
        fprintf(stderr, "Dropped position was not saved or preserved\n"); exit(1);
    }
    printf("Native dragging checks passed: moves, detaches the notch, saves coordinates and preserves the dropped anchor.\n");
    finish();
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
                BOOL animation = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
                for (NSNumber *width in widths) if (width.doubleValue > compact.size.width && width.doubleValue < expanded.size.width) animation = YES;
                if (expanded.size.width < 600 || expanded.size.height <= compact.size.height + 100 || !anchored || !animation || !fixedCanvas) {
                    fprintf(stderr,"Expansion failed: compact=%.0fx%.0f drawn=%s expanded=%.0fx%.0f anchored=%d animated=%d\n",compact.size.width,compact.size.height,widths.description.UTF8String,expanded.size.width,expanded.size.height,anchored,animation); exit(1);
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
                                verifyMenuLayout(^{ verifyDragging(^{ verifyPresentationLifetime(^{ verifyInlineSettings(^{ clawtab_nfn_stop(); }); }); }); });
                            });
                            return;
                        }
                        [surface.web evaluateJavaScript:@"document.querySelector('textarea').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.querySelector('textarea').focus()" completionHandler:^(id result, NSError *focusError) {
                            (void)result;
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                                if (focusError || !surface.panel.textFocus || !surface.panel.isKeyWindow) { fprintf(stderr,"Reply focus lease failed: error=%s lease=%d key=%d can-key=%d\n",focusError.localizedDescription.UTF8String,surface.panel.textFocus,surface.panel.isKeyWindow,surface.panel.canBecomeKeyWindow); exit(1); }
                                verifyEditing(^{
                                    clawtab_nfn_activate(previousApplication);
                                    verifyExpansion(^{
                                        printf("Native checks passed: platform JSON booleans, passive panel, foreground preserved, notch overlap, window cycling excluded, reply focus, Command-A selection, animated expansion and fixed top anchor. Screenshots: /tmp/clawtab-nfn-native.png, /tmp/clawtab-nfn-expanded.png\n");
                                        verifyMenuLayout(^{ verifyDragging(^{ verifyPresentationLifetime(^{ verifyInlineSettings(^{ clawtab_nfn_stop(); }); }); }); });
                                    });
                                });
                            });
                        }];
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
