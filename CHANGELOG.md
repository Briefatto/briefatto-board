# Changelog

## 0.1.7

- Briefatto Board is for every agent: the guide is a plain file in the project, the protocol is a plain skill file, and the work is done by a CLI any agent can call.

## 0.1.6

- One stop on the brief path: the three direction sheets. Pick one, ask for changes, or say 'you choose'. Missing facts are asked for in that same message, or named as missing at handoff; never invented. The pick is the production approval.
- Add `board freeze . <id> --agent-picked "<reason>"` for a first freeze the person delegated. `board log` shows the reason, the handoff shows the other two directions, and `board freeze . <other-id> --note "Switch to direction <other-id>"` switches.
- Use and record every client reference. The agent's own reference capture is research and is never shown for a pick.
- A page colour the frozen board declares, such as a cream ground the client asked for, passes the floor with a note.

## 0.1.5

- Add design principles and an architecture guide, link the blind test and the DESIGN.md gallery, and add the Claude Code plugin install.

## 0.1.4

- Document skills.sh installation and improve npm metadata.

## 0.1.3

- Verify final PNG and PDF deliverables by decoding and comparing their pixels with the editable HTML. Record file hashes and comparison results in the check and kit receipts.
- Require a frozen guide for kits and verbatim client approval for a new direction's first freeze. Record an explicit solo approval in the version log.
- Record client-supplied asset origins, allow approved copy to reflow at standalone middle dots, and suppress overlaps between fragments of the same text node.
- Add help for every subcommand and point users to the next command or the exact missing format field.

## 0.1.2

- Declare the launch campaign when assembling a kit, check the deliverables against the brief, and record their scope in the receipt. Exclude review pieces and support copy requirements per format.
- Generate verbatim brief and client wording plus exact rendered styles in a marked DESIGN.md block. Preserve the authored guide and name any conflicting style values.
- Warn about empty reference captures only when there is negligible page content. Keep browser overlay hiding.

## 0.1.1

- Check visible copy for clipping and overlap, and report which checks ran or were skipped. Freeze requires campaign copy on the selected designs.
- Check the font weight and style each piece actually uses. Preview exact brief and sample values before freezing.
- Capture references in one browser and flag unusable captures. Review the reference sheet with the client before drawing directions.
- Declare print dimensions, bleed, and story safe zones in project formats. Check print button treatments and story copy placement.
