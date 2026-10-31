#pragma once
#include <xpc/xpc.h>

#define OARLOCK_GIT_PROTOCOL 2
// No caller-supplied filesystem path, executable, environment or command is
// admitted by this bootstrap protocol. Candidate execution stays unavailable
// until its snapshot, hook-supervision and publication protocols are complete.
const char *oarlock_git_request_error(xpc_object_t message);
xpc_object_t oarlock_git_response(xpc_object_t message, bool sandboxed, bool git_verified);
