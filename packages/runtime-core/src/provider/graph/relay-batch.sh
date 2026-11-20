# Start several relays from one guest call: $1 is the per-slot relay script, then
# eleven arguments per slot. Each slot runs that unchanged script concurrently, so
# the socket waits overlap. One short line per slot, written by a single printf
# (atomic below PIPE_BUF): "<index> running" or "<index> failed".
relay_script=$1; shift
payload=$(cat)
index=0
while test "$#" -gt 0; do
 test "$#" -ge 11
 (
  if result=$(printf '%s\n' "$payload" | sh -c "$relay_script" relay "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" 2>/dev/null); then
   printf '%s %s\n' "$index" "$result"
  else
   printf '%s failed\n' "$index"
  fi
 ) &
 shift 11
 index=$((index+1))
done
wait
