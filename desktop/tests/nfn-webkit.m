// Run the renderer checks in a disposable macOS desktop, such as Tart.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

@interface NotificationChecks : NSObject <WKNavigationDelegate>
@property NSString *script;
@property NSWindow *window;
@property NSString *screenshotPath;
@end

@implementation NotificationChecks
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    NSString *script = [@"return await " stringByAppendingString:self.script];
    [webView callAsyncJavaScript:script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
        if (error) { fprintf(stderr, "%s\n", error.description.UTF8String); exit(1); }
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
        if (!json) { fprintf(stderr, "%s\n", error.description.UTF8String); exit(1); }
        printf("%s\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
        if (!self.screenshotPath) { exit(0); }
        [webView takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *snapshotError) {
            if (!image || snapshotError) { fprintf(stderr, "Could not capture renderer screenshot\n"); exit(1); }
            NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            if (![png writeToFile:self.screenshotPath atomically:YES]) { exit(1); }
            exit(0);
        }];
    }];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    fprintf(stderr, "%s\n", error.description.UTF8String); exit(1);
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3 && argc != 4) return 2;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NotificationChecks *checks = [NotificationChecks new];
        checks.script = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[2]] encoding:NSUTF8StringEncoding error:nil];
        if (argc == 4) checks.screenshotPath = [NSString stringWithUTF8String:argv[3]];
        if (!checks.script) return 2;
        NSDictionary *environment = NSProcessInfo.processInfo.environment;
        double width = environment[@"NFN_CHECK_WIDTH"] ? [environment[@"NFN_CHECK_WIDTH"] doubleValue] : 1280;
        double height = environment[@"NFN_CHECK_HEIGHT"] ? [environment[@"NFN_CHECK_HEIGHT"] doubleValue] : 900;
        NSRect frame = NSMakeRect(40, 40, width, height);
        checks.window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        WKWebView *web = [[WKWebView alloc] initWithFrame:frame];
        web.navigationDelegate = checks;
        checks.window.contentView = web;
        [checks.window makeKeyAndOrderFront:nil];
        [NSApp activate];
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
        [web loadFileURL:url allowingReadAccessToURL:url.URLByDeletingLastPathComponent];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            fprintf(stderr, "Notification renderer checks timed out\n"); exit(1);
        });
        [NSApp run];
    }
    return 1;
}
