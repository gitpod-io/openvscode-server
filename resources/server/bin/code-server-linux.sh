#!/usr/bin/env sh
#
# Copyright (c) Microsoft Corporation. All rights reserved.
#

case "$1" in
	--inspect*) INSPECT="$1"; shift;;
esac

ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"

if [ -z "$GP_VSCODE_NODE" ]; then
	GP_VSCODE_NODE="$ROOT/node"
fi

"$GP_VSCODE_NODE" ${INSPECT:-} "$ROOT/out/server-main.js" "$@"
