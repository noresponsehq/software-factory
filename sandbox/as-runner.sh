#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/env"
home="$FACTORY_SCRATCH_DIR/home" tmp="$FACTORY_SCRATCH_DIR/tmp"
mkdir -p "$home" "$tmp"
uid=$(id -u "$FACTORY_RUN_AS")
gid=$(id -g "$FACTORY_RUN_AS")
[ "$uid" -gt 0 ] || { echo 'as-runner: an unprivileged runner is required' >&2; exit 1; }
current_uid=$(id -u)
if [ "$current_uid" = 0 ]; then
	chown -h "$uid:$gid" "$home" "$tmp"
elif [ "$current_uid" != "$uid" ]; then
	echo 'as-runner: cannot assume the configured runner identity' >&2
	exit 1
fi
cd "$FACTORY_REPO_DIR"
env_args=(
	HOME="$home" TMPDIR="$tmp" PATH="$FACTORY_PATH" LANG=C.UTF-8 USER="$FACTORY_RUN_AS"
	GIT_CONFIG_GLOBAL="$FACTORY_APP_DIR/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
)
launch() {
	fd_dir="/proc/$$/fd"
	if [ ! -d "$fd_dir" ] && [ "$current_uid" != 0 ]; then fd_dir=/dev/fd; fi
	[ -d "$fd_dir" ] || { echo 'as-runner: descriptor inventory unavailable' >&2; exit 1; }
	for descriptor in "$fd_dir/"*; do
		descriptor=${descriptor##*/}
		case "$descriptor" in ''|*[!0-9]*) exit 1 ;; esac
		if [ "$descriptor" -gt 2 ]; then eval "exec ${descriptor}>&-"; fi
	done
	if [ "$current_uid" = 0 ]; then
		exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- /usr/bin/env -i "${env_args[@]}" "$@"
	fi
	exec /usr/bin/env -i "${env_args[@]}" "$@"
}
launch "$@"
