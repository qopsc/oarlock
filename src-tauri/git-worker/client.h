#pragma once
#include <stddef.h>
#include <stdbool.h>
// Blocking off the UI thread; XPC waits at most five seconds after local signature
// validation. Writes only a fixed diagnostic code.
// 0 = authenticated sandboxed worker with verified Apple Git,
// 2 = authenticated sandboxed worker requiring Apple Git, 1 = helper failure.
int oarlock_git_worker_probe(const char *app_id, char *detail, size_t capacity, bool development);
