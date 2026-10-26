// Foreground visual smoke test. No daemon, job, or user preferences are changed.
// clang -fobjc-arc -fblocks nfn-native.m -framework AppKit -framework WebKit
//   -framework Intents -framework UserNotifications -framework ApplicationServices
//   -o /tmp/clawtab-nfn-native
// Generate the HTML with nfn-fixture.mjs FILE --native, then pass FILE here.
#import "../src-tauri/src/nfn/macos.m"

static BOOL loaded;
static NSUInteger attempts;
static pid_t previousApplication;

static void bridge(const char *raw) {
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    NSString *operation = value[@"command"][@"op"];
    if ([operation isEqual:@"platform"] || !value[@"token"]) return;
    NSDictionary *result = @{};
    if ([operation isEqual:@"context"]) result = @{@"log":@"Review ready\nWaiting for a decision",@"models":@[],@"plugins":@[],@"source":@{}};
    clawtab_nfn_push([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:@{@"type":@"response",@"token":value[@"token"],@"value":result} options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
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
                snapshot[@"settings"] = @{@"delivery":@"enhanced",@"focus":@"independent",@"placement":@"notch",@"display":@"primary",@"preview_seconds":@8};
                [surface push:snapshot];
                [surface.web evaluateJavaScript:@"document.querySelector('#surface').dispatchEvent(new MouseEvent('mouseenter')); [...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Expand')).click()" completionHandler:nil];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                    BOOL nonactivating = (surface.panel.styleMask & NSWindowStyleMaskNonactivatingPanel) != 0;
                    BOOL foregroundPreserved = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == previousApplication;
                    BOOL geometry = surface.panel.frame.size.width >= 390 && surface.panel.frame.size.height > 100 && surface.panel.frame.size.height < 700;
                    BOOL passive = !surface.panel.canBecomeKeyWindow;
                    if (!nonactivating || !foregroundPreserved || !geometry || !passive || !surface.panel.visible) {
                        fprintf(stderr,"Native panel checks failed: mask=%d foreground=%d geometry=%d passive=%d visible=%d frame=%.0fx%.0f surface=%.0fx%.0f ready=%d\n",nonactivating,foregroundPreserved,geometry,passive,surface.panel.visible,surface.panel.frame.size.width,surface.panel.frame.size.height,surface.surfaceWidth,surface.surfaceHeight,surface.ready); exit(1);
                    }
                    [surface.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
                        if (snapshotError || !image) { fprintf(stderr,"Native snapshot failed\n"); exit(1); }
                        NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                        [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@"/tmp/clawtab-nfn-native.png" atomically:YES];
                        [surface.web evaluateJavaScript:@"document.querySelector('textarea').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.querySelector('textarea').focus()" completionHandler:^(id result, NSError *focusError) {
                            (void)result;
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 4), dispatch_get_main_queue(), ^{
                                if (focusError || !surface.panel.textFocus || !surface.panel.isKeyWindow) { fprintf(stderr,"Reply focus lease failed\n"); exit(1); }
                                [surface releaseTextFocus];
                                if (surface.panel.canBecomeKeyWindow || surface.panel.textFocus) { fprintf(stderr,"Reply focus was not released\n"); exit(1); }
                                printf("Native checks passed: nonactivating panel, foreground preserved, display geometry, reply focus and release. Snapshot: /tmp/clawtab-nfn-native.png\n");
                                clawtab_nfn_stop();
                            });
                        }];
                    }];
                });
            }];
        }];
        return clawtab_nfn_run(html.UTF8String,bridge);
    }
}
