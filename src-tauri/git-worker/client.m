#include "client.h"
#include "protocol.h"
#include "signature.h"
#include <string.h>

int oarlock_git_worker_probe(const char *app_id, char *detail, size_t capacity, bool development) {
    @autoreleasepool {
        if (!app_id || !detail || capacity < 64) return 1;
        strlcpy(detail, "helper_unavailable", capacity);
        NSString *appId = [NSString stringWithUTF8String:app_id];
        NSBundle *app = [NSBundle mainBundle];
        bool matchesProfile = appId && [app.bundleIdentifier isEqualToString:appId];
        // Tauri's debug data profile is isolated at runtime; the debug bundle
        // itself can still carry the configured production identifier.
        matchesProfile = matchesProfile || (development && [app.bundleIdentifier isEqualToString:@"consulting.quantumops.oarlock"] &&
            [appId isEqualToString:@"consulting.quantumops.oarlock.dev"]);
        if (!matchesProfile) return 1;
        NSString *serviceId = [appId stringByAppendingString:@".git-worker"];
        NSURL *bundle = [app.bundleURL URLByAppendingPathComponent:@"Contents/XPCServices/OarlockGitWorker.xpc"];
        NSString *requirement = oarlock_requirement(bundle, serviceId);
        if (!requirement) return 1;
        xpc_connection_t connection = xpc_connection_create(serviceId.UTF8String, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
        if (!connection || xpc_connection_set_peer_code_signing_requirement(connection, requirement.UTF8String) != 0) return 1;
        NSLock *lock = [NSLock new];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block bool finished = false;
        __block bool accepted = false;
        __block NSString *outcome = @"helper_unavailable";
        void (^complete)(bool, NSString *) = ^(bool success, NSString *reason) {
            [lock lock];
            if (!finished) {
                finished = true;
                accepted = success;
                outcome = reason;
                dispatch_semaphore_signal(done);
            }
            [lock unlock];
        };
        xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
            if (xpc_get_type(event) == XPC_TYPE_ERROR) complete(false, @"helper_connection_failed");
        });
        xpc_connection_resume(connection);
        NSString *requestId = [[[NSUUID UUID] UUIDString] stringByReplacingOccurrencesOfString:@"-" withString:@""].lowercaseString;
        xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_uint64(message, "version", OARLOCK_GIT_PROTOCOL);
        xpc_dictionary_set_string(message, "operation", "capabilities");
        xpc_dictionary_set_string(message, "request", requestId.UTF8String);
        xpc_connection_send_message_with_reply(connection, message, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^(xpc_object_t reply) {
            if (xpc_get_type(reply) != XPC_TYPE_DICTIONARY) { complete(false, @"helper_connection_failed"); return; }
            xpc_object_t version = xpc_dictionary_get_value(reply, "version");
            xpc_object_t request = xpc_dictionary_get_value(reply, "request");
            xpc_object_t sandbox = xpc_dictionary_get_value(reply, "sandboxed");
            xpc_object_t ready = xpc_dictionary_get_value(reply, "executionReady");
            xpc_object_t git = xpc_dictionary_get_value(reply, "gitVerified");
            const char *error = xpc_dictionary_get_string(reply, "error");
            if (!version || xpc_get_type(version) != XPC_TYPE_UINT64 || xpc_uint64_get_value(version) != OARLOCK_GIT_PROTOCOL ||
                !request || xpc_get_type(request) != XPC_TYPE_STRING || strcmp(xpc_string_get_string_ptr(request), requestId.UTF8String) ||
                !sandbox || xpc_get_type(sandbox) != XPC_TYPE_BOOL ||
                !ready || xpc_get_type(ready) != XPC_TYPE_BOOL || xpc_bool_get_value(ready) ||
                !git || xpc_get_type(git) != XPC_TYPE_BOOL || !error) {
                complete(false, @"helper_protocol_mismatch"); return;
            }
            if (!xpc_bool_get_value(sandbox)) {
                complete(false, @"helper_confinement_failed"); return;
            }
            bool verified = xpc_bool_get_value(git);
            const char *expected = verified ? "candidate_execution_unavailable" : "apple_git_required";
            if (strcmp(error, expected)) { complete(false, @"helper_protocol_mismatch"); return; }
            complete(true, verified ? @"candidate_execution_unavailable" : @"apple_git_required");
        });
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0)
            complete(false, @"helper_timeout");
        [lock lock];
        int result = !accepted ? 1 : [outcome isEqualToString:@"apple_git_required"] ? 2 : 0;
        strlcpy(detail, outcome.UTF8String, capacity);
        [lock unlock];
        xpc_connection_cancel(connection);
        return result;
    }
}
