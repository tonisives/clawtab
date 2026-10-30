// Make a portrait test fixture from real footage without external media tools.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) return 2;
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]] options:nil];
        AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        if (!track) { fprintf(stderr, "The real product clip has no video track\n"); return 1; }
        CGSize canvas = CGSizeMake(360, 640);
        CGRect source = CGRectApplyAffineTransform((CGRect){CGPointZero, track.naturalSize}, track.preferredTransform);
        CGFloat scale = MIN(canvas.width / source.size.width, canvas.height / source.size.height);
        CGAffineTransform transform = CGAffineTransformConcat(track.preferredTransform, CGAffineTransformMakeTranslation(-source.origin.x, -source.origin.y));
        transform = CGAffineTransformConcat(transform, CGAffineTransformMakeScale(scale, scale));
        transform = CGAffineTransformConcat(transform, CGAffineTransformMakeTranslation((canvas.width - source.size.width * scale) / 2, (canvas.height - source.size.height * scale) / 2));
        CMTime duration = CMTimeMinimum(asset.duration, CMTimeMake(3, 1));
        AVMutableVideoCompositionLayerInstruction *layer = [AVMutableVideoCompositionLayerInstruction videoCompositionLayerInstructionWithAssetTrack:track];
        [layer setTransform:transform atTime:kCMTimeZero];
        AVMutableVideoCompositionInstruction *instruction = [AVMutableVideoCompositionInstruction videoCompositionInstruction];
        instruction.timeRange = CMTimeRangeMake(kCMTimeZero, duration); instruction.layerInstructions = @[layer];
        AVMutableVideoComposition *composition = [AVMutableVideoComposition videoComposition];
        composition.renderSize = canvas; composition.frameDuration = CMTimeMake(1, 30); composition.instructions = @[instruction];
        AVAssetExportSession *export = [[AVAssetExportSession alloc] initWithAsset:asset presetName:AVAssetExportPresetHighestQuality];
        export.outputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
        [[NSFileManager defaultManager] removeItemAtURL:export.outputURL error:nil];
        export.outputFileType = AVFileTypeMPEG4; export.videoComposition = composition;
        export.timeRange = instruction.timeRange; export.shouldOptimizeForNetworkUse = YES;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [export exportAsynchronouslyWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)) != 0) {
            [export cancelExport]; fprintf(stderr, "Portrait fixture export timed out\n"); return 1;
        }
        if (export.status != AVAssetExportSessionStatusCompleted) { fprintf(stderr, "%s\n", export.error.description.UTF8String); return 1; }
        printf("Portrait fixture: 360 by 640, three seconds, real product footage\n");
        return 0;
    }
}
