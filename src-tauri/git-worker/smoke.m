#include "client.h"
#include "protocol.h"
#import "apple_git.h"
#import <Foundation/Foundation.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

static void protocol_tests(void) {
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(message, "version", OARLOCK_GIT_PROTOCOL);
    xpc_dictionary_set_string(message, "operation", "capabilities");
    xpc_dictionary_set_string(message, "request", "0123456789abcdef0123456789abcdef");
    assert(oarlock_git_request_error(message) == NULL);
    xpc_dictionary_set_string(message, "repoRoot", "/private/unauthorized");
    assert(!strcmp(oarlock_git_request_error(message), "invalid_fields"));
    xpc_dictionary_set_value(message, "repoRoot", NULL);
    xpc_dictionary_set_string(message, "operation", "commit");
    assert(!strcmp(oarlock_git_request_error(message), "unsupported_operation"));
    xpc_dictionary_set_string(message, "operation", "capabilities");
    xpc_dictionary_set_int64(message, "version", OARLOCK_GIT_PROTOCOL);
    assert(!strcmp(oarlock_git_request_error(message), "unsupported_protocol"));
    xpc_dictionary_set_uint64(message, "version", OARLOCK_GIT_PROTOCOL + 1);
    assert(!strcmp(oarlock_git_request_error(message), "unsupported_protocol"));
    xpc_dictionary_set_uint64(message, "version", OARLOCK_GIT_PROTOCOL);
    xpc_dictionary_set_string(message, "request", "../");
    assert(!strcmp(oarlock_git_request_error(message), "invalid_request_id"));
    xpc_dictionary_set_string(message, "request", "0123456789abcdef0123456789abcdef");
    xpc_object_t response = oarlock_git_response(message, false, true);
    assert(!xpc_dictionary_get_bool(response, "executionReady"));
    assert(!strcmp(xpc_dictionary_get_string(response, "error"), "confinement_unavailable"));
    assert(!xpc_dictionary_get_bool(response, "gitVerified"));
    response = oarlock_git_response(message, true, false);
    assert(!xpc_dictionary_get_bool(response, "executionReady"));
    assert(!xpc_dictionary_get_bool(response, "gitVerified"));
    assert(!strcmp(xpc_dictionary_get_string(response, "error"), "apple_git_required"));
    response = oarlock_git_response(message, true, true);
    assert(xpc_dictionary_get_bool(response, "gitVerified"));
    assert(!xpc_dictionary_get_bool(response, "executionReady"));
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        protocol_tests();
        if (argc == 2 && !strcmp(argv[1], "--protocol")) return 0;
        assert(oarlock_git_owned_mode(0, S_IFREG | 0755, false));
        assert(!oarlock_git_owned_mode(501, S_IFREG | 0755, false));
        assert(!oarlock_git_owned_mode(0, S_IFREG | 0775, false));
        assert(!oarlock_git_owned_mode(0, S_IFLNK | 0755, false));
        assert(!oarlock_git_owned_mode(0, S_IFREG | 04755, false));
        assert(!oarlock_git_owned_mode(0, S_IFDIR | 0775, true));
        assert(!oarlock_git_protected_path("/usr/bin/../bin/git"));
        assert(!oarlock_git_protected_path("/opt/homebrew/bin/git"));
        assert(!oarlock_git_apple_signature([NSBundle mainBundle].executableURL));
        if (argc == 2 && !strcmp(argv[1], "--apple-git")) {
            NSURL *installed = oarlock_apple_git();
            if (installed) {
                NSString *folder = [NSTemporaryDirectory() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
                NSFileManager *files = [NSFileManager defaultManager];
                assert([files createDirectoryAtPath:folder withIntermediateDirectories:NO attributes:nil error:NULL]);
                NSURL *copy = [NSURL fileURLWithPath:[folder stringByAppendingPathComponent:@"git"]];
                assert([files copyItemAtURL:installed toURL:copy error:NULL]);
                assert(oarlock_git_apple_signature(copy));
                assert(!oarlock_git_protected_path(copy.path.fileSystemRepresentation));
                assert([files removeItemAtPath:folder error:NULL]);
                puts("Apple signature accepted; writable relocation rejected");
            } else {
                puts("No protected Apple Git on this host; negative predicates passed");
            }
            return 0;
        }
        char detail[128] = {0};
        int status = oarlock_git_worker_probe([NSBundle mainBundle].bundleIdentifier.UTF8String, detail, sizeof(detail), false);
        printf("{\"connected\":%s,\"detail\":\"%s\"}\n", (status == 0 || status == 2) ? "true" : "false", detail);
        return status == 2 ? 0 : status;
    }
}
