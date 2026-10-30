// Real local-video playback in the production native panel; run only in the shared VM.
#import "../src-tauri/src/nfn/macos.m"

static NSData *clip;
static NSUInteger attempts;
static BOOL presented;
static NSString *output;

static void reply(NSDictionary *request, NSDictionary *value) {
    NSDictionary *response = @{@"type":@"response", @"token":request[@"token"], @"value":value};
    NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    clawtab_nfn_push([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}

static void receive(const char *raw) {
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    NSDictionary *command = request[@"command"];
    if (!command) return;
    if ([command[@"op"] isEqual:@"respond"]) { fprintf(stderr,"Video checks must never submit a review decision\n"); exit(1); }
    if ([command[@"op"] isEqual:@"media"]) {
        NSUInteger offset = [command[@"offset"] unsignedIntegerValue], length = [command[@"length"] unsignedIntegerValue];
        if (![command[@"id"] isEqual:@"video-review"] || [command[@"index"] unsignedIntegerValue] != 0 || offset > clip.length || length > 256*1024) exit(1);
        NSUInteger count = MIN(length,clip.length-offset);
        reply(request,@{@"size":@(clip.length),@"offset":@(offset),@"mime":@"video/mp4",@"data":[[clip subdataWithRange:NSMakeRange(offset,count)] base64EncodedStringWithOptions:0]});
    } else if ([command[@"op"] isEqual:@"context"]) {
        reply(request,@{@"log":@"Earlier shell output\nLatest shell output",@"source":@{}});
    } else reply(request,@{});
}

static void finishChecks(void) {
    NSString *script = @"const v=document.querySelector('video'), src=v.src, poster=v.poster, body=document.querySelector('.message-content'); const time=v.currentTime; if(v.paused||v.error||time<.2)throw Error('The native Play button did not advance the video'); document.querySelector('.details-toggle').click(); await new Promise(r=>setTimeout(r,150)); if(v.paused||v.src!==src||v.poster!==poster||document.querySelector('video')!==v||body.hidden||!body.contains(document.querySelector('.details-content')))throw Error('Details interrupted or replaced the post/video'); document.querySelector('.details-toggle').click(); const width=v.getBoundingClientRect().width; for(let i=0;i<4;i++)document.querySelector('.resize-e').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true})); await new Promise(r=>setTimeout(r,150)); if(document.querySelector('.logs')||body.hidden||v.src!==src||v.paused||v.getBoundingClientRect().width<=width)throw Error('Resizing failed to retain and enlarge the playing post'); v.pause(); return {passed:6,src:src.slice(0,5),poster:poster.length,width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime};";
    [surface.web callAsyncJavaScript:script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
        if (error) { fprintf(stderr,"%s\n",error.description.UTF8String); exit(1); }
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        printf("Native video: %s\n",[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        [surface.web takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) {
            if (!image || error) exit(1);
            NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            if (![[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:output atomically:YES]) exit(1);
            clawtab_nfn_stop();
        }];
    }];
}

static void clickPlay(NSArray *point) {
    CGFloat y = [point[1] doubleValue];
    NSPoint local = NSMakePoint([point[0] doubleValue],surface.web.isFlipped ? y : surface.web.bounds.size.height-y);
    NSPoint position = [surface.panel convertPointToScreen:[surface.web convertPoint:local toView:nil]];
    CGPoint global = CGPointMake(position.x,NSScreen.screens.firstObject.frame.size.height-position.y);
    CGEventRef down = CGEventCreateMouseEvent(NULL,kCGEventLeftMouseDown,global,kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(NULL,kCGEventLeftMouseUp,global,kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap,down); CGEventPost(kCGHIDEventTap,up); CFRelease(down); CFRelease(up);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{ finishChecks(); });
}

int main(int argc,const char **argv) {
    @autoreleasepool {
        if (argc != 4) return 2;
        NSString *html = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[1]] encoding:NSUTF8StringEncoding error:nil];
        clip = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
        output = [NSString stringWithUTF8String:argv[3]];
        if (!html || !clip.length) return 2;
        [NSApplication sharedApplication];
        [NSTimer scheduledTimerWithTimeInterval:.2 repeats:YES block:^(NSTimer *timer) {
            if (++attempts > 150) { fprintf(stderr,"Native video thumbnail did not load\n"); exit(1); }
            if (!surface.ready) return;
            if (!presented) {
                presented = YES;
                [surface.web evaluateJavaScript:@"JSON.stringify(window.fixture.snapshot('video-review'))" completionHandler:^(id value, NSError *error) {
                    if (error) exit(1);
                    NSMutableDictionary *snapshot = [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding] options:NSJSONReadingMutableContainers error:nil];
                    snapshot[@"settings"] = @{@"delivery":@"enhanced",@"focus":@"follow",@"placement":@"right",@"display":@"primary",@"preview_seconds":@120};
                    [surface push:snapshot];
                    [surface.web evaluateJavaScript:@"window.nfn.receive({type:'open_record',id:'video-review'})" completionHandler:nil];
                }];
                return;
            }
            [surface.web evaluateJavaScript:@"(()=>{const v=document.querySelector('video'),p=document.querySelector('.media-play');if(!v||v.readyState<2||!v.poster||!v.src.startsWith('blob:')||p.disabled)return null; const r=p.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];})()" completionHandler:^(id point, NSError *error) {
                if (error || ![point isKindOfClass:NSArray.class]) return;
                [timer invalidate]; clickPlay(point);
            }];
        }];
        return clawtab_nfn_run(html.UTF8String,NULL,0,receive);
    }
}
