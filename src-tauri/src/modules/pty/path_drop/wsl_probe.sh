# Fixed helper, invoked without user startup scripts. All inputs are arguments.
set -eu
PATH=/usr/bin:/bin
export PATH
token=$1
expected=$(/usr/bin/readlink -f -- "$2")
mode=$3
shift 3
owner=
# One scan process, rather than forking grep once for every process in a distro.
# -l returns only numeric /proc filenames, never environment contents.
candidates=$(/usr/bin/grep -azlF -- "OARLOCK_DROP_OWNER=$token:" /proc/[0-9]*/environ 2>/dev/null || :)
for environment in $candidates; do
    pid=${environment#/proc/}
    pid=${pid%/environ}
    if /usr/bin/grep -azFxq -- "OARLOCK_DROP_OWNER=$token:$pid" "$environment" 2>/dev/null; then
        [ -z "$owner" ] || exit 1
        owner=$pid
    fi
done
[ -n "$owner" ] || exit 1
verify() {
    [ "$(/usr/bin/readlink -f -- "/proc/$owner/exe")" = "$expected" ] || return 1
    IFS= read -r stat < "/proc/$owner/stat" || return 1
    # Fields after comm: state ppid pgrp session tty_nr tpgid ...
    rest=${stat##*) }
    set -- $rest
    [ "$3" = "$owner" ] && [ "$6" = "$owner" ] && [ "$5" != 0 ] || return 1
    # Without job control, a child can share the shell's foreground group.
    # Foreground-group equality alone therefore does not identify the reader.
    for member in /proc/[0-9]*; do
        [ "${member##*/}" != "$owner" ] || continue
        IFS= read -r stat < "$member/stat" 2>/dev/null || continue
        rest=${stat##*) }
        set -- $rest
        [ "$3" != "$owner" ] || return 1
    done
}
verify || exit 1
printf '%s\000' "$expected"
for path do
    if [ "$mode" = host ]; then
        path=$(/usr/bin/wslpath -a -u "$path") || exit 1
    fi
    case "$path" in /*) ;; *) exit 1 ;; esac
    printf '%s\000' "$path"
done
verify
