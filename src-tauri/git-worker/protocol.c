#include "protocol.h"
#include <string.h>

const char *oarlock_git_request_error(xpc_object_t message) {
    if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) return "invalid_request";
    if (xpc_dictionary_get_count(message) != 3) return "invalid_fields";
    xpc_object_t version = xpc_dictionary_get_value(message, "version");
    xpc_object_t operation = xpc_dictionary_get_value(message, "operation");
    xpc_object_t request = xpc_dictionary_get_value(message, "request");
    if (!version || xpc_get_type(version) != XPC_TYPE_UINT64 ||
        xpc_uint64_get_value(version) != OARLOCK_GIT_PROTOCOL) return "unsupported_protocol";
    if (!request || xpc_get_type(request) != XPC_TYPE_STRING ||
        xpc_string_get_length(request) != 32) return "invalid_request_id";
    const char *id = xpc_string_get_string_ptr(request);
    for (size_t i = 0; i < 32; i++) {
        if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f')))
            return "invalid_request_id";
    }
    if (!operation || xpc_get_type(operation) != XPC_TYPE_STRING ||
        xpc_string_get_length(operation) != strlen("capabilities") ||
        strcmp(xpc_string_get_string_ptr(operation), "capabilities")) return "unsupported_operation";
    return NULL;
}

xpc_object_t oarlock_git_response(xpc_object_t message, bool sandboxed, bool git_verified) {
    xpc_object_t response = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_uint64(response, "version", OARLOCK_GIT_PROTOCOL);
    const char *error = oarlock_git_request_error(message);
    if (error) {
        xpc_dictionary_set_string(response, "error", error);
        return response;
    }
    xpc_dictionary_set_string(response, "request", xpc_dictionary_get_string(message, "request"));
    xpc_dictionary_set_bool(response, "sandboxed", sandboxed);
    xpc_dictionary_set_bool(response, "executionReady", false);
    xpc_dictionary_set_bool(response, "gitVerified", sandboxed && git_verified);
    xpc_dictionary_set_string(response, "error", sandboxed ? (git_verified ? "candidate_execution_unavailable" : "apple_git_required") : "confinement_unavailable");
    return response;
}
