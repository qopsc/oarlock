#import "apple_git.h"
#import <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string.h>

bool oarlock_git_owned_mode(uid_t owner, mode_t mode, bool directory) {
    return owner == 0 && (mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID)) == 0 &&
        (directory ? S_ISDIR(mode) : (S_ISREG(mode) && (mode & S_IXUSR)));
}
static bool protected_fd(int fd, bool directory) {
    struct stat state;
    filesec_t security = filesec_init();
    if (!security) return false;
    int present = 0;
    bool accepted = fstatx_np(fd, &state, security) == 0 &&
        oarlock_git_owned_mode(state.st_uid, state.st_mode, directory) &&
        filesec_query_property(security, FILESEC_ACL, &present) == 0;
    // An absent ACL is explicit metadata, not an inference from an error.
    // acl_get_fd() alone conflates a missing ACL with ENOENT failures.
    if (accepted && present) {
        acl_t acl = NULL;
        accepted = filesec_get_property(security, FILESEC_ACL, &acl) == 0 && acl;
        if (accepted) {
            acl_entry_t entry;
            bool valid = acl_valid(acl) == 0;
            errno = 0;
            int result = valid ? acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) : 0;
            accepted = valid && result == -1 && errno == EINVAL;
        }
        if (acl) acl_free(acl);
    }
    filesec_free(security);
    return accepted;
}
bool oarlock_git_protected_path(const char *path) {
    if (!path || path[0] != '/' || strlen(path) > 4096) return false;
    NSString *value = [NSString stringWithUTF8String:path];
    if (!value) return false;
    NSArray<NSString *> *components = [value componentsSeparatedByString:@"/"];
    if (components.count < 2) return false;
    int directory = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) return false;
    bool accepted = protected_fd(directory, true);
    for (NSUInteger i = 1; accepted && i < components.count; i++) {
        NSString *part = components[i];
        if (!part.length || [part isEqualToString:@"."] || [part isEqualToString:@".."]) { accepted = false; break; }
        bool parent = i + 1 < components.count;
        int next = openat(directory, part.fileSystemRepresentation,
            O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (parent ? O_DIRECTORY : 0));
        close(directory);
        directory = next;
        accepted = next >= 0 && protected_fd(next, parent);
    }
    if (directory >= 0) close(directory);
    return accepted;
}
bool oarlock_git_apple_signature(NSURL *url) {
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    CFDictionaryRef information = NULL;
    OSStatus status = SecRequirementCreateWithString(CFSTR("anchor apple and identifier \"com.apple.git\""), kSecCSDefaultFlags, &requirement);
    if (status == errSecSuccess) status = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
    if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, requirement);
    if (status == errSecSuccess) status = SecCodeCopySigningInformation((SecCodeRef)code, kSecCSSigningInformation, &information);
    if (status == errSecSuccess) {
        NSDictionary *info = (__bridge NSDictionary *)information;
        NSNumber *flags = info[(__bridge NSString *)kSecCodeInfoFlags];
        NSDictionary *entitlements = info[(__bridge NSString *)kSecCodeInfoEntitlementsDict];
        // Keep the loader bound to trusted libraries too; an Apple executable
        // loading a user-replaced dylib is not sufficient provenance.
        if (![flags isKindOfClass:[NSNumber class]] || !(flags.unsignedIntValue & kSecCodeSignatureLibraryValidation) ||
            [entitlements[@"com.apple.security.cs.disable-library-validation"] boolValue])
            status = errSecCSReqFailed;
    }
    if (information) CFRelease(information);
    if (code) CFRelease(code);
    if (requirement) CFRelease(requirement);
    return status == errSecSuccess;
}
NSURL *oarlock_apple_git(void) {
    for (NSString *path in @[@"/Library/Developer/CommandLineTools/usr/bin/git",
                             @"/Applications/Xcode.app/Contents/Developer/usr/bin/git"]) {
        // This also prevents an unprivileged rename between signature checking
        // and launch. A hostile privileged installer is outside this boundary.
        if (!oarlock_git_protected_path(path.fileSystemRepresentation)) continue;
        NSURL *url = [NSURL fileURLWithPath:path];
        if (oarlock_git_apple_signature(url) && oarlock_git_protected_path(path.fileSystemRepresentation)) return url;
    }
    return nil;
}
