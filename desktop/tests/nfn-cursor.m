// Cursor diagnostics run only in the shared disposable macOS VM.
#import "../src-tauri/src/nfn/macos.m"

static NSString *output;
static NSMutableArray *observations;
static NSWindow *reference;
static NSPoint initialPointer;
static NSUInteger attempts;
static BOOL loaded;
static NSUInteger trackingCallbacks;
static pid_t initialForeground;
static NSArray *steps;
static NSCursor *southeast, *southwest;
static void moveTo(NSPoint point);

static void require(BOOL condition, NSString *message) {
    if (condition) return;
    fprintf(stderr,"Cursor check failed: %s\n",message.UTF8String);
    [surface.panel orderOut:nil];
    moveTo(initialPointer);
    exit(1);
}

static BOOL backgroundAllowed(void) {
    CFTypeRef value = NULL;
    require(cursorConnection && cursorCopyProperty && cursorSetProperty,@"VM must expose background cursor diagnostics");
    int cid = cursorConnection();
    require(cursorCopyProperty(cid,cid,CFSTR("SetsCursorInBackground"),&value) == kCGErrorSuccess,@"read connection property");
    BOOL enabled = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value);
    if (value) CFRelease(value);
    return enabled;
}

static NSData *imageData(NSImage *image) {
    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
    return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

static NSDictionary *describeCursor(NSCursor *cursor) {
    if (!cursor) return @{ @"available": @NO };
    return @{ @"available": @YES, @"class": NSStringFromClass(cursor.class),
              @"hotspot": @[@(cursor.hotSpot.x), @(cursor.hotSpot.y)],
              @"size": @[@(cursor.image.size.width), @(cursor.image.size.height)] };
}

static void saveImage(NSImage *image, NSString *name) {
    if (!image) return;
    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[output stringByAppendingPathComponent:name] atomically:YES];
}

static BOOL capture(NSString *name, NSPoint point, BOOL cursor) {
    CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
    NSString *rectangle = [NSString stringWithFormat:@"%.0f,%.0f,96,96", point.x-48, top-point.y-48];
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/sbin/screencapture"];
    NSMutableArray *args = [NSMutableArray arrayWithObjects:@"-x", @"-R", rectangle, nil];
    if (cursor) [args addObject:@"-C"];
    [args addObject:[output stringByAppendingPathComponent:[name stringByAppendingString:cursor ? @"-screen-cursor.png" : @"-screen.png"]]];
    task.arguments = args;
    NSError *error;
    if (![task launchAndReturnError:&error]) { fprintf(stderr,"Capture launch failed: %s\n",error.description.UTF8String); return NO; }
    [task waitUntilExit];
    return task.terminationStatus == 0;
}

static void moveTo(NSPoint point) {
    CGPoint global = CGPointMake(point.x,NSMaxY(NSScreen.screens.firstObject.frame)-point.y);
    CGEventRef event = CGEventCreateMouseEvent(NULL,kCGEventMouseMoved,global,kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap,event); CFRelease(event);
}

static void observe(NSString *name, NSPoint point, void (^finish)(void)) {
    moveTo(NSMakePoint(point.x-1,point.y));
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/5),dispatch_get_main_queue(),^{
        moveTo(point);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/2),dispatch_get_main_queue(),^{
            NSMutableDictionary *state = [@{ @"name":name, @"point":@[@(point.x),@(point.y)],
                @"process_cursor":describeCursor(NSCursor.currentCursor),
                @"system_cursor":describeCursor(NSCursor.currentSystemCursor),
                @"key":@(surface.panel.isKeyWindow), @"keyboard_lease":@(surface.panel.keyboardFocus),
                @"foreground":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
                @"cursor_owned":@(resizeCursorOwned), @"background_changed":@(backgroundCursorChanged),
                @"background_allowed":@(backgroundAllowed()),
                @"ignores_mouse":@(surface.panel.ignoresMouseEvents), @"tracking_callbacks":@(trackingCallbacks),
                @"surface_frame":NSStringFromRect(surface.surfaceFrame),
                @"canvas_frame":NSStringFromRect(surface.panel.frame),
                @"scale":@(surface.panel.backingScaleFactor) } mutableCopy];
            saveImage(NSCursor.currentCursor.image,[name stringByAppendingString:@"-process-cursor.png"]);
            saveImage(NSCursor.currentSystemCursor.image,[name stringByAppendingString:@"-system-cursor.png"]);
            state[@"screen_capture_with_cursor"] = @(capture(name,point,YES));
            state[@"screen_capture_without_cursor"] = @(capture(name,point,NO));
            [observations addObject:state];
            NSData *json = [NSJSONSerialization dataWithJSONObject:observations options:NSJSONWritingPrettyPrinted error:nil];
            [json writeToFile:[output stringByAppendingPathComponent:@"observations.json"] atomically:YES];
            printf("Cursor observation: %s\n",name.UTF8String); fflush(stdout);
            finish();
        });
    });
}

static void sendPointer(NSEventType type, NSPoint point) {
    [NSApp sendEvent:[NSEvent mouseEventWithType:type location:[surface.panel convertPointFromScreen:point] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil eventNumber:1 clickCount:1 pressure:type == NSEventTypeLeftMouseUp ? 0 : 1]];
}

static void verifyOptionalAPI(void) {
    NSCursor *prior = NSCursor.currentCursor;
    [NSCursor.crosshairCursor set];
    CGError (*copyProperty)(int,int,CFStringRef,CFTypeRef *) = cursorCopyProperty;
    cursorCopyProperty = NULL;
    setResizeCursor(southeast);
    require(!backgroundCursorChanged,@"missing optional API must retain AppKit fallback");
    setResizeCursor(nil);
    cursorCopyProperty = copyProperty;
    require(NSCursor.currentCursor == NSCursor.crosshairCursor && !backgroundAllowed(),@"missing API restores prior cursor and permission");
    int cid = cursorConnection();
    require(cursorSetProperty(cid,cid,CFSTR("SetsCursorInBackground"),kCFBooleanTrue) == kCGErrorSuccess,@"prepare prior enabled permission");
    setResizeCursor(southeast);
    require(!backgroundCursorChanged,@"already enabled permission must remain owned by prior caller");
    setResizeCursor(nil);
    require(backgroundAllowed() && NSCursor.currentCursor == NSCursor.crosshairCursor,@"restore prior enabled permission and cursor");
    require(cursorSetProperty(cid,cid,CFSTR("SetsCursorInBackground"),kCFBooleanFalse) == kCGErrorSuccess,@"restore test permission");
    [prior set];
    printf("Optional API absence and prior cursor/permission preservation passed.\n");
}

static NSDictionary *step(NSString *name, NSPoint point, NSCursor *cursor, BOOL owned, BOOL active, void (^action)(void)) {
    return @{ @"name":name, @"point":[NSValue valueWithPoint:point], @"cursor":cursor,
        @"owned":@(owned), @"active":@(active), @"action":[action copy] };
}

static void runStep(NSUInteger index) {
    if (index == steps.count) {
        NSRect f = surface.surfaceFrame;
        observe(@"outside-before-optional-api",NSMakePoint(NSMinX(f)-30,NSMinY(f)-30),^{
            verifyOptionalAPI();
            observe(@"stop-while-hovering",NSMakePoint(NSMaxX(f)-12,NSMinY(f)+12),^{
                require(resizeCursorOwned && backgroundAllowed(),@"stop begins with resize ownership");
                clawtab_nfn_stop();
            });
        });
        return;
    }
    NSDictionary *item = steps[index];
    ((void (^)(void))item[@"action"])();
    observe(item[@"name"],[item[@"point"] pointValue],^{
        require(NSCursor.currentSystemCursor != nil,@"displayed system cursor diagnostics unavailable");
        require([observations.lastObject[@"screen_capture_with_cursor"] boolValue] && [observations.lastObject[@"screen_capture_without_cursor"] boolValue],@"paired screen capture must succeed");
        require([imageData(NSCursor.currentSystemCursor.image) isEqual:imageData([item[@"cursor"] image])], [item[@"name"] stringByAppendingString:@": displayed system cursor differs"]);
        require(resizeCursorOwned == [item[@"owned"] boolValue] && backgroundAllowed() == ([item[@"owned"] boolValue] || (surface.panel.visible && NSPointInRect(NSEvent.mouseLocation,surface.surfaceFrame))), [item[@"name"] stringByAppendingString:@": cursor permission leaked or missing"]);
        BOOL active = [item[@"active"] boolValue];
        require(surface.panel.isKeyWindow == active && surface.panel.keyboardFocus == active,@"hover must preserve keyboard lease");
        require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == (active ? NSProcessInfo.processInfo.processIdentifier : initialForeground),@"hover must preserve foreground app");
        runStep(index+1);
    });
}

static void runObservations(void) {
    NSCursor *(^original)(NSEvent *) = surface.web.resizeCursor;
    surface.web.resizeCursor = ^NSCursor *(NSEvent *event) { trackingCallbacks++; return original(event); };
    if (@available(macOS 15.0,*)) {
        southeast = [NSCursor frameResizeCursorFromPosition:NSCursorFrameResizePositionBottomRight inDirections:NSCursorFrameResizeDirectionsAll];
        southwest = [NSCursor frameResizeCursorFromPosition:NSCursorFrameResizePositionBottomLeft inDirections:NSCursorFrameResizeDirectionsAll];
        saveImage(southeast.image,@"expected-se.png");
        saveImage(southwest.image,@"expected-sw.png");
    }
    reference = [[NSWindow alloc] initWithContentRect:NSMakeRect(80,80,360,260) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    reference.releasedWhenClosed = NO;
    reference.title = @"Native cursor reference";
    [reference orderFrontRegardless];
    NSRect rf = reference.frame;
    observe(@"reference-se",NSMakePoint(NSMaxX(rf)-3,NSMinY(rf)+3),^{
        [reference orderOut:nil];
        NSRect f = surface.surfaceFrame;
        NSPoint se = NSMakePoint(NSMaxX(f)-12,NSMinY(f)+12);
        NSPoint outside = NSMakePoint(NSMinX(f)-30,NSMinY(f)-30);
        NSPoint content = NSMakePoint(NSMidX(f),NSMidY(f));
        void (^noop)(void) = ^{};
        steps = @[
            step(@"passive-se-center",se,southeast,YES,NO,noop),
            step(@"passive-se-edge",NSMakePoint(NSMaxX(f)-3,NSMinY(f)+3),southeast,YES,NO,noop),
            step(@"passive-sw-center",NSMakePoint(NSMinX(f)+12,NSMinY(f)+12),southwest,YES,NO,noop),
            step(@"content-restored",content,NSCursor.arrowCursor,NO,NO,noop),
            step(@"passive-reentry",se,southeast,YES,NO,noop),
            step(@"hidden-restored",se,NSCursor.arrowCursor,NO,NO,^{
                [surface.panel orderOut:nil];
                NSEvent *late = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:[surface.panel convertPointFromScreen:se] modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:surface.panel.windowNumber context:nil eventNumber:1 clickCount:0 pressure:0];
                [surface.web cursorUpdate:late];
            }),
            step(@"reshown-se",se,southeast,YES,NO,^{ [surface.panel orderFrontRegardless]; }),
            step(@"drag-held-outside",outside,southeast,YES,NO,^{ sendPointer(NSEventTypeLeftMouseDown,se); }),
            step(@"drag-finished-outside",outside,NSCursor.arrowCursor,NO,NO,^{ sendPointer(NSEventTypeLeftMouseUp,outside); }),
            step(@"active-se-center",se,southeast,YES,YES,^{ [surface beginKeyboardFocus]; }),
            step(@"keyboard-released",content,NSCursor.arrowCursor,NO,NO,^{ [surface endKeyboardFocus:YES]; })
        ];
        runStep(0);
    });
}

// Move the system pointer without activating the panel. DOM-dispatched events do
// not exercise WebKit's tracking areas or the cursor displayed by WindowServer.
static void hoverTarget(NSString *selector, NSString *phase, void (^finish)(NSPoint)) {
    NSString *script = [NSString stringWithFormat:@"(() => { const b = document.querySelector('%@'); const r = b.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2, getComputedStyle(b).backgroundColor]; })()", selector];
    [surface.web evaluateJavaScript:script completionHandler:^(id target, NSError *error) {
        require(!error && [target isKindOfClass:NSArray.class], @"measure hover target");
        CGFloat y = [target[1] doubleValue];
        NSPoint point = [surface.web convertPoint:NSMakePoint([target[0] doubleValue], surface.web.isFlipped ? y : surface.web.bounds.size.height - y) toView:nil];
        point = [surface.panel convertPointToScreen:point];
        moveTo(NSMakePoint(point.x-1,point.y));
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/10),dispatch_get_main_queue(),^{ moveTo(point); });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/3),dispatch_get_main_queue(),^{
            NSString *check = [NSString stringWithFormat:@"(() => { const b = document.querySelector('%@'); return [b.matches(':hover, [data-native-hover]'), getComputedStyle(b).backgroundColor]; })()",selector];
            [surface.web evaluateJavaScript:check completionHandler:^(id state, NSError *hoverError) {
                if (hoverError || ![state[0] boolValue]) {
                    fprintf(stderr,"Hover delivery: %s state=%s target=%s point=%s flipped=%d ignores=%d tracking=%s\n", phase.UTF8String,[state description].UTF8String,[target description].UTF8String,NSStringFromPoint(point).UTF8String,surface.web.isFlipped,surface.panel.ignoresMouseEvents,[surface.web.trackingAreas description].UTF8String);
                }
                require(!hoverError && [state[0] boolValue], [phase stringByAppendingString:@": real mouse movement must highlight the button before a click"]);
                require([selector isEqual:@"textarea"] || ![state[1] isEqual:target[2]], [phase stringByAppendingString:@": CSS hover highlight must change"]);
                finish(point);
            }];
        });
    }];
}

static void sampleCursor(NSPoint point, NSUInteger count, NSString *phase, NSCursor *expected, void (^finish)(void)) {
    require([imageData(NSCursor.currentSystemCursor.image) isEqual:imageData(expected.image)], [phase stringByAppendingString:@": content cursor flickered"]);
    if (!count) { finish(); return; }
    moveTo(NSMakePoint(point.x + (count % 2 ? 3 : -3), point.y));
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/100),dispatch_get_main_queue(),^{ sampleCursor(point,count-1,phase,expected,finish); });
}

static void clickAt(NSPoint point, void (^finish)(void)) {
    CGPoint global = CGPointMake(point.x,NSMaxY(NSScreen.screens.firstObject.frame)-point.y);
    for (NSNumber *type in @[@(kCGEventLeftMouseDown), @(kCGEventLeftMouseUp)]) {
        CGEventRef event = CGEventCreateMouseEvent(NULL,type.unsignedIntValue,global,kCGMouseButtonLeft);
        CGEventPost(kCGHIDEventTap,event); CFRelease(event);
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/3),dispatch_get_main_queue(),finish);
}

static void verifyContentHover(NSUInteger phase, void (^finish)(void)) {
    if (phase == 4) {
        [surface.web evaluateJavaScript:@"document.querySelector('.menu-overlay')?.click()" completionHandler:^(id value, NSError *error) {
            [surface releaseTextFocus];
            [[NSRunningApplication runningApplicationWithProcessIdentifier:initialForeground] activateWithOptions:NSApplicationActivateIgnoringOtherApps];
            moveTo(initialPointer);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/3),dispatch_get_main_queue(),finish);
        }];
        return;
    }
    NSString *selector = phase == 0 ? @".reply-toggle" : phase == 2 ? @".reply-toggle" : @".session-action";
    NSString *name = @[@"passive-card", @"passive-menu", @"reply-card", @"menu-after-reply"][phase];
    pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    NSPoint outside = NSMakePoint(NSMinX(surface.surfaceFrame)-30,NSMinY(surface.surfaceFrame)-30);
    moveTo(outside);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/5),dispatch_get_main_queue(),^{
        hoverTarget(selector,name,^(NSPoint point) {
            require(!surface.panel.isKeyWindow && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == foreground, @"passive hover must preserve foreground and keyboard focus");
            sampleCursor(point,50,name,NSCursor.pointingHandCursor,^{
                printf("Content hover and stable pointing hand: %s (50 moving samples).\n",name.UTF8String);
                void (^advance)(void) = ^{
                    hoverTarget(@"[aria-haspopup=menu]",@"Got it",^(NSPoint acknowledge) {
                        void (^openMenu)(void) = ^{ clickAt(acknowledge,^{ verifyContentHover(phase+1,finish); }); };
                        if (phase == 2) {
                            require(surface.panel.isKeyWindow && surface.panel.textFocus,@"Reply must take text focus before opening the menu");
                            sampleCursor(acknowledge,50,@"reply-focused-card",NSCursor.pointingHandCursor,openMenu);
                        } else openMenu();
                    });
                };
                if (phase == 0 || phase == 2) {
                    if (phase == 2) clickAt(point,^{
                        hoverTarget(@"textarea",@"reply-text-cursor",^(NSPoint input) {
                            sampleCursor(input,50,@"reply-text-cursor",NSCursor.IBeamCursor,advance);
                        });
                    }); else advance();
                } else {
                    [surface.web evaluateJavaScript:@"document.querySelector('.menu-overlay')?.click()" completionHandler:^(id value, NSError *error) {
                        verifyContentHover(phase+1,finish);
                    }];
                }
            });
        });
    });
}

static void receive(const char *raw) {
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (!request[@"token"]) return;
    NSDictionary *response = @{ @"type":@"response", @"token":request[@"token"], @"value":@{} };
    clawtab_nfn_push([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:response options:0 error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}

int main(int argc,const char **argv) {
    @autoreleasepool {
        if (argc != 3) return 2;
        NSString *html = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[1]] encoding:NSUTF8StringEncoding error:nil];
        output = [NSString stringWithUTF8String:argv[2]];
        [[NSFileManager defaultManager] createDirectoryAtPath:output withIntermediateDirectories:YES attributes:nil error:nil];
        observations = [NSMutableArray array];
        initialPointer = NSEvent.mouseLocation;
        initialForeground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        [NSApplication sharedApplication];
        [NSTimer scheduledTimerWithTimeInterval:.2 repeats:YES block:^(NSTimer *timer) {
            if (loaded) { [timer invalidate]; return; }
            if (++attempts > 100) exit(1);
            if (!surface.ready) return;
            [surface.web evaluateJavaScript:@"window.fixture && JSON.stringify(window.fixture.snapshot('first'))" completionHandler:^(id value,NSError *error) {
                if (loaded || error || ![value isKindOfClass:NSString.class]) return;
                loaded = YES;
                NSMutableDictionary *snapshot = [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingMutableContainers error:nil];
                snapshot[@"settings"] = @{ @"delivery":@"enhanced", @"focus":@"independent", @"placement":@"right", @"display":@"primary", @"preview_seconds":@120 };
                [surface push:snapshot];
                [surface.web evaluateJavaScript:@"document.querySelector('#surface').dispatchEvent(new MouseEvent('mouseenter'))" completionHandler:nil];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{ verifyContentHover(0, ^{ runObservations(); }); });
            }];
        }];
        int result = clawtab_nfn_run(html.UTF8String,NULL,0,receive);
        require(!resizeCursorOwned && !backgroundAllowed(),@"stop must release cursor ownership and permission");
        moveTo(initialPointer);
        [reference close];
        printf("Displayed native corner cursors, passive focus, exit/hide/drag/stop restoration passed.\n");
        return result;
    }
}
