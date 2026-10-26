// Foreground visual smoke test. No daemon, job, or user preferences are changed.
// clang -fobjc-arc -fblocks nfn-native.m -framework AppKit -framework WebKit
//   -framework Intents -framework UserNotifications -framework ApplicationServices
//   -o /tmp/clawtab-nfn-native
// Generate the HTML with nfn-fixture.mjs FILE --native, then pass FILE here.
// --right checks the fallback position; --geometry-only skips keyboard focus.
#import "../src-tauri/src/nfn/macos.m"

static BOOL loaded;
static BOOL platformReceived;
static NSUInteger attempts;
static pid_t previousApplication;

static void verifyExpansion(void (^finish)(void)) {
    NSRect compact = surface.panel.frame;
    [surface.web evaluateJavaScript:@"document.querySelector('.details-toggle').click()" completionHandler:^(id value, NSError *error) {
        if (error) { fprintf(stderr,"Details did not open\n"); exit(1); }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), ^{
            [surface.web evaluateJavaScript:@"document.querySelector('#surface').getBoundingClientRect().width" completionHandler:^(id drawnWidth, NSError *measureError) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), dispatch_get_main_queue(), ^{
                NSRect expanded = surface.panel.frame;
                BOOL anchored = fabs(NSMaxY(expanded) - NSMaxY(compact)) < 1;
                BOOL animation = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion || (!measureError &&
                    [drawnWidth doubleValue] > compact.size.width && [drawnWidth doubleValue] < expanded.size.width);
                if (expanded.size.width < 600 || expanded.size.height <= compact.size.height + 100 || !anchored || !animation) {
                    fprintf(stderr,"Expansion failed: compact=%.0fx%.0f drawn=%.0f expanded=%.0fx%.0f anchored=%d animated=%d\n",compact.size.width,compact.size.height,[drawnWidth doubleValue],expanded.size.width,expanded.size.height,anchored,animation); exit(1);
                }
                [surface.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                    if (snapshotError || !image) { fprintf(stderr,"Expanded snapshot failed\n"); exit(1); }
                    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@"/tmp/clawtab-nfn-expanded.png" atomically:YES];
                    finish();
                }];
            });
            }];
        });
    }];
}

static void bridge(const char *raw) {
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    NSString *operation = value[@"command"][@"op"];
    if ([operation isEqual:@"platform"]) {
        NSDictionary *state = value[@"command"][@"state"];
        for (NSString *key in @[@"available", @"sound_allowed", @"user_active", @"focused", @"authorized"]) {
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
        BOOL geometryOnly = argc == 3 && strcmp(argv[2], "--geometry-only") == 0;
        NSString *html = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[1]] encoding:NSUTF8StringEncoding error:nil];
        if (!html) return 2;
        previousApplication = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
            if (loaded) { [timer invalidate]; return; }
            if (++attempts > 100) { fprintf(stderr,"Native renderer did not load\n"); exit(1); }
            [surface.web evaluateJavaScript:@"window.fixture && JSON.stringify(window.fixture.snapshot('first'))" completionHandler:^(id value, NSError *error) {
                if (loaded || error || ![value isKindOfClass:NSString.class]) return;
                loaded = YES;
                NSMutableDictionary *snapshot = [[NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingMutableContainers error:nil] mutableCopy];
                snapshot[@"records"][0][@"request"][@"title"] = @"Notification layout test";
                snapshot[@"records"][0][@"request"][@"body"] = @"Checking notch alignment and resize animation. This temporary test closes automatically.";
                snapshot[@"settings"] = @{@"delivery":@"enhanced",@"focus":@"independent",@"placement":rightColumn ? @"right" : @"notch",@"display":@"built_in",@"preview_seconds":@8};
                [surface push:snapshot];
                [surface.web evaluateJavaScript:@"document.querySelector('#surface').dispatchEvent(new MouseEvent('mouseenter'))" completionHandler:nil];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                    BOOL nonactivating = (surface.panel.styleMask & NSWindowStyleMaskNonactivatingPanel) != 0;
                    BOOL foregroundPreserved = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == previousApplication;
                    BOOL geometry = surface.panel.frame.size.width >= 390 && surface.panel.frame.size.height > 100 && surface.panel.frame.size.height < 700;
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
                                clawtab_nfn_stop();
                            });
                            return;
                        }
                        [surface.web evaluateJavaScript:@"document.querySelector('textarea').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.querySelector('textarea').focus()" completionHandler:^(id result, NSError *focusError) {
                            (void)result;
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                                if (focusError || !surface.panel.textFocus || !surface.panel.isKeyWindow) { fprintf(stderr,"Reply focus lease failed: error=%s lease=%d key=%d can-key=%d\n",focusError.localizedDescription.UTF8String,surface.panel.textFocus,surface.panel.isKeyWindow,surface.panel.canBecomeKeyWindow); exit(1); }
                                [surface releaseTextFocus];
                                if (surface.panel.canBecomeKeyWindow || surface.panel.textFocus) { fprintf(stderr,"Reply focus was not released\n"); exit(1); }
                                verifyExpansion(^{
                                    printf("Native checks passed: platform JSON booleans, passive panel, foreground preserved, notch overlap, window cycling excluded, reply focus, animated expansion and fixed top anchor. Screenshots: /tmp/clawtab-nfn-native.png, /tmp/clawtab-nfn-expanded.png\n");
                                    clawtab_nfn_stop();
                                });
                            });
                        }];
                    }];
                });
            }];
        }];
        return clawtab_nfn_run(html.UTF8String,bridge);
    }
}
