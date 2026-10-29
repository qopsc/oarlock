#pragma once
#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <sys/types.h>

// The resolver admits fixed Apple installations only. No PATH, DEVELOPER_DIR,
// request-supplied executable or xcrun launch occurs inside the worker.
NSURL *oarlock_apple_git(void);
// Separated predicates permit negative tests without changing root-owned files.
bool oarlock_git_owned_mode(uid_t owner, mode_t mode, bool directory);
bool oarlock_git_protected_path(const char *path);
bool oarlock_git_apple_signature(NSURL *url);
