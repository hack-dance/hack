# Run one relay action for several slots from one guest call: $1 is the per-slot
# relay script, $2 is `stdin` (each slot reads this call's input, the relay
# payload for a start) or `none`, then eleven arguments per slot. Each slot runs
# that unchanged script concurrently. One short line per slot, written by a
# single printf (atomic below PIPE_BUF): "<index> <result>" or "<index> failed".
relay_script=$1; input=$2; shift 2
case "$input" in stdin) payload=$(cat);; none) payload=;; *) exit 1;; esac
index=0
while test "$#" -gt 0; do
 test "$#" -ge 11
 (
  if test "$input" = stdin; then
   result=$(printf '%s\n' "$payload" | sh -c "$relay_script" relay "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" 2>/dev/null) || result=failed
  else
   result=$(sh -c "$relay_script" relay "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" </dev/null 2>/dev/null) || result=failed
  fi
  printf '%s %s\n' "$index" "$result"
 ) &
 shift 11
 index=$((index+1))
done
wait
