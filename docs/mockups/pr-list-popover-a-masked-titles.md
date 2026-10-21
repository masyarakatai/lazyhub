# PR list popover - Variant A: popover floats, covered rows keep only their right-hand columns (CHOSEN)

The popover opens below the focused row at the list's left edge (DESIGN_REVAMP §12.1:
right, then below, above, left). Rows under it have their title cell blanked, so the
popover's right edge never exposes a title tail; CI, author and age stay readable.

```
 open/closed/merged · mine [O]open [C]closed [M]merged [s]scope [@]author
  ● #142 feat(guidance): add closed-loop attitude controller   ✓ ✓ @maria-lopez 2h
 ▎● #141 fix(telemetry): drop duplicate frames on reconnect    ● 1/3 @dev-agent  5h
 ╭──────────────────────────────────────────────────╮
 │ #141 fix(telemetry): drop duplicate frames on r… │
 │ open · @dev-agent → main · 5h                    │                     (blank)
 │ ──────────────────────────────────────────────── │
 │ ## Summary                                       │                 ✓ @dependabot 20h
 │ ...                                              │               ● 1/1 @jin-park 1d
 ╰──────────────────────────────────────────────────╯
```

Pros: no layout shift (DESIGN_REVAMP principle 1), keeps right-hand metadata, no row
disappears. Cons: a gap in the title column while the popover is open.

# Variant B: popover widens to the full list width

Popover spans the whole list body so it fully replaces the rows beneath it.

```
 ▎● #141 fix(telemetry): drop duplicate frames on reconnect    ● 1/3 @dev-agent  5h
 ╭───────────────────────────────────────────────────────────────────────────────╮
 │ #141 fix(telemetry): drop duplicate frames on reconnect                       │
 │ ...                                                                           │
 ╰───────────────────────────────────────────────────────────────────────────────╯
```

Pros: no fragments by construction. Cons: very wide box with mostly empty space at 120+
cols, hides all metadata of the covered rows, and departs from the 52-col popover
contract in DESIGN_REVAMP §12.1.

Decision: A.
