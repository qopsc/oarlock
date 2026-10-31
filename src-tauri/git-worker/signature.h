#import <Foundation/Foundation.h>
#import <Security/Security.h>

// Bind the installed helper to the running host's Apple signing team first.
// Validating an arbitrary replacement's own signature is not authentication.
static inline NSString *oarlock_host_authority(void) {
    SecCodeRef host = NULL;
    CFDictionaryRef info = NULL;
    NSString *authority = nil;
    OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &host);
    if (status == errSecSuccess) status = SecCodeCopySigningInformation(host, kSecCSSigningInformation, &info);
    if (status == errSecSuccess) {
        id team = [(__bridge NSDictionary *)info objectForKey:(__bridge NSString *)kSecCodeInfoTeamIdentifier];
        if ([team isKindOfClass:[NSString class]] && [team length] == 10 &&
            [team rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] invertedSet]].location == NSNotFound) {
            authority = [NSString stringWithFormat:@"anchor apple generic and certificate leaf[subject.OU] = \"%@\"", team];
        }
    }
    if (info) CFRelease(info);
    if (host) CFRelease(host);
    return authority;
}

// The installed helper's designated requirement additionally pins ad-hoc test
// fixtures to their cdhash and preserves release signing requirements.
static inline NSString *oarlock_requirement(NSURL *url, NSString *identifier) {
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    SecRequirementRef authority = NULL;
    NSString *hostAuthority = oarlock_host_authority();
#if defined(OARLOCK_TESTING)
    if (!hostAuthority && [[NSBundle mainBundle].bundleIdentifier isEqualToString:@"consulting.quantumops.oarlock.dev.git-worker-tests"])
        hostAuthority = @"true"; // Isolated ad-hoc transport fixture only.
#endif
    if (!hostAuthority || SecRequirementCreateWithString((__bridge CFStringRef)hostAuthority, kSecCSDefaultFlags, &authority) != errSecSuccess)
        return nil;
    CFStringRef text = NULL;
    CFDictionaryRef info = NULL;
    NSString *result = nil;
    OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
    if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, authority);
    if (status == errSecSuccess) status = SecCodeCopySigningInformation((SecCodeRef)code, kSecCSSigningInformation, &info);
    if (status == errSecSuccess) {
        id entitlements = [(__bridge NSDictionary *)info objectForKey:(__bridge NSString *)kSecCodeInfoEntitlementsDict];
        NSDictionary *expected = @{@"com.apple.security.app-sandbox": @YES};
        if (![entitlements isKindOfClass:[NSDictionary class]] || ![entitlements isEqualToDictionary:expected])
            status = errSecCSReqFailed;
    }
    if (status == errSecSuccess) status = SecCodeCopyDesignatedRequirement((SecCodeRef)code, kSecCSDefaultFlags, &requirement);
    if (status == errSecSuccess) status = SecRequirementCopyString(requirement, kSecCSDefaultFlags, &text);
    if (status == errSecSuccess) {
        result = [NSString stringWithFormat:@"(%@) and (%@) and identifier \"%@\"", hostAuthority, (__bridge NSString *)text, identifier];
    }
    if (info) CFRelease(info);
    if (authority) CFRelease(authority);
    if (text) CFRelease(text);
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return result;
}

