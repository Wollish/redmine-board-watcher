#!/usr/bin/env python3
"""
check_stuck.py <log_file> <fail_regex> <success_regex> <threshold>

Looks at the tail of a watcher's log and classifies each cycle-outcome line
as a failure (F) or a success (S), based on the two regexes. Prints STUCK if
the most recent `threshold` classified lines are ALL failures (i.e. the
watcher has been failing every single cycle in a row, not just one blip).
Prints OK otherwise (healthy, or not enough history yet to judge).

Only reads the tail of the file (last ~300KB) so this stays cheap even as
the log grows unbounded over weeks.
"""
import re
import sys

TAIL_BYTES = 300_000

def main():
    log_file, fail_re, success_re, threshold = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    fail_pat = re.compile(fail_re)
    success_pat = re.compile(success_re)

    with open(log_file, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - TAIL_BYTES))
        chunk = f.read().decode('utf-8', errors='ignore')

    tags = []
    for line in chunk.splitlines():
        if fail_pat.search(line):
            tags.append('F')
        elif success_pat.search(line):
            tags.append('S')

    recent = tags[-threshold:] if len(tags) >= threshold else []
    if len(recent) == threshold and all(t == 'F' for t in recent):
        print('STUCK')
    else:
        print('OK')

if __name__ == '__main__':
    main()
