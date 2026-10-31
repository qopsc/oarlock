#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <fcntl.h>
#include <unistd.h>
#include "protocol.h"
#import "apple_git.h"

#ifndef OARLOCK_PARENT_REQUIREMENT
#error OARLOCK_PARENT_REQUIREMENT must be selected by the signing profile
#endif

static bool confined(NSURL *bundle) {
    SecTaskRef task = SecTaskCreateFromSelf(NULL);
    if (!task) return false;
    CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.security.app-sandbox"), NULL);
    bool enabled = value && CFEqual(value, kCFBooleanTrue);
    if (value) CFRelease(value);
    CFRelease(task);
    if (!enabled) return false;
    // Do not modify the file. The signed helper bundle must be readable but
    // not writable from the helper; an entitlement alone is not a runtime test.
    const char *path = [[[bundle URLByAppendingPathComponent:@"Contents/Info.plist"] path] fileSystemRepresentation];
    int read_fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (read_fd < 0) return false;
    close(read_fd);
    int write_fd = open(path, O_WRONLY | O_NOFOLLOW | O_CLOEXEC);
    if (write_fd >= 0) { close(write_fd); return false; }
    return errno == EPERM || errno == EACCES;
}

static bool sandboxActive;
static void accept_peer(xpc_connection_t peer) {
    NSString *peerRequirement = @OARLOCK_PARENT_REQUIREMENT;
    if (!peerRequirement) { xpc_connection_cancel(peer); return; }
    if (xpc_connection_set_peer_code_signing_requirement(peer, peerRequirement.UTF8String) != 0) {
        xpc_connection_cancel(peer);
        return;
    }
    xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
        @autoreleasepool {
            if (xpc_get_type(event) != XPC_TYPE_DICTIONARY) return;
            xpc_object_t reply = xpc_dictionary_create_reply(event);
            if (!reply) return;
            xpc_object_t fields = oarlock_git_response(event, sandboxActive, sandboxActive && oarlock_git_request_error(event) == NULL && oarlock_apple_git() != nil);
            xpc_dictionary_apply(fields, ^bool(const char *key, xpc_object_t value) {
                xpc_dictionary_set_value(reply, key, value);
                return true;
            });
            xpc_connection_send_message(peer, reply);
        }
    });
    xpc_connection_resume(peer);
}
int main(void) {
    @autoreleasepool {
        NSURL *bundle = [NSBundle mainBundle].bundleURL;
        sandboxActive = confined(bundle);
        xpc_main(accept_peer);
    }
}
