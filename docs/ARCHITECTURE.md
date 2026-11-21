# How Briefatto Board works: the architecture of a design system for coding agents

Briefatto Board is a skill that tells a coding agent how to run a design process, plus a command-line tool that renders, measures, versions and checks everything that process produces. The agent's model makes every aesthetic decision, and deterministic code turns the chosen design into a stamped, versioned DESIGN.md, fails any piece that breaks the floor, and reports which pieces follow the current brand.

## One boundary

A design layer for agents has two jobs that pull in opposite directions. It has to leave room for taste, which lives in the model and improves every year. It also has to hold a brand fixed across sessions and agents for months on end, which only a program does reliably. We drew a hard line between those jobs. Judgement runs in the agent, while everything that can be measured or proven runs in code, on the rendered output, and lands in files in the repository. The companion [design principles](PRINCIPLES.md) argue for where the line sits; this piece shows how it is built.

## The layers

**The skill.** `SKILL.md` is the protocol the agent follows. It tells the agent to read a frozen DESIGN.md before any visual work, lays out both entries step by step, and marks the places where the agent stops for a person, such as showing the reference sheet before drawing a single direction.

**The CLI.** `npx briefatto-board` runs `install`, `adopt`, `refs`, `directions`, `freeze`, `check`, `kit`, `status`, `log` and `diff`. Every command that looks at a design renders it in headless Chromium through Playwright and reads computed styles, text geometry, font loading and contrast from the live page, on your machine.

**Install.** `board install` copies the skill and its launcher into `.claude/skills/briefatto-board/`, adds the package as a dev dependency, and writes a block between `<!-- briefatto-board:start -->` and `<!-- briefatto-board:end -->` into `AGENTS.md` and `CLAUDE.md`. Before a freeze, the block points the agent at the skill. After a freeze it carries standing rules: read `DESIGN.md` before any visual work, send brand changes through `board freeze`, and run `board check` on every piece before handing it over. Claude Code, Codex, Cursor and every agent that reads `AGENTS.md` pick them up.

**DESIGN.md and its generated block.** The guide has two authors. The agent writes the prose, which works as the handoff from one designer to the next: it names each recurring part by its job, says how it is built and how it recomposes on each canvas. `board freeze` writes what can be measured into a block between `<!-- briefatto-board:generated begin -->` and `<!-- briefatto-board:generated end -->`. For a brand started from a brief, that block holds the brand facts and campaign copy with the source of every line, and the client's musts and must-nots, quoted verbatim. For every sample it holds a table of each text role's font stack, size, weight, style and colour, plus every painted colour. Later freezes replace the block in place and leave the prose to the agent.

**Validation.** Freeze reads the prose against the render. Every colour, font family and font size the prose names must exist in the computed samples. A claim tied to a role, such as the colour of the price numeral, must match that role's measured values, and `data-board-role` names a role in a sample. Campaign copy must match its source exactly, and every referenced file, font load lines included, must resolve inside the project. A contradiction fails the freeze with the line number and the nearest real value.

**Stamps and the archive.** A passing freeze hashes the guide with SHA-256, records the hash in `board/board.json`, and stamps the guide after its front matter: `<!-- briefatto-board:freeze vN YYYY-MM-DD sha256:<hash> -->`. The new board is built in a staging directory under a lock. The previous `board/` becomes `board.vN` beside it, and the stage becomes current. Guide, instruction blocks and board directory move together, and a failure rolls all of them back. The board holds the rendered samples, `board.json` with the measured palette, type roles, radii, device and composition, a `tokens.css` of CSS custom properties, and a stylescape of the direction. A freeze with unchanged sources creates no version, and an archived guide is read back only while its hash matches its record.

**The render-and-check floor.** `board check` runs the open-source [Impeccable](https://github.com/pbakaus/impeccable) detector on the HTML source, then renders the piece at its canvas size and fails text that is clipped, off the canvas, over other text, or too small at the width where it is seen; fonts that never loaded; text below WCAG contrast; and story copy inside declared unsafe zones. Campaign pieces must carry the brief's required copy, body copy at reading size and supplied images. Every PNG and PDF in `deliverables.json` is decoded and compared with its HTML source. The receipt, `check.json`, lists every check that ran and every check skipped, with the reason.

**Status and diff.** Each piece declares its version in its head: `<meta name="board-version" content="v2">`. `board status` reads that tag from every piece under `outputs/` and reports it current, stale or unrecorded. When `board check` finds a piece using colours or fonts outside the current board, it names the version they came from, and status carries that finding while the piece's source is unchanged. `board diff v1 v2` compares measured values role by role. `board log` lists every version with its date, its note and how the first freeze was approved.

## The data flow

```
  EXISTING SITE                              NEW BRAND
  board adopt .                    [code]    brief.md, essentials.json          [person + model]
    pages at desktop and mobile              board refs . --capture <url> <png> [code]
    -> .briefatto/adoption/                  refs/manifest.json -> refs/sheet.png
       screenshots + evidence.json           client says what to work from      [person]
  agent reads captures and styles  [model]   agent draws directions/<id>/       [model]
  agent writes DESIGN.md prose     [model]   board directions . -> sheet.png    [code]
                                             client picks; approval and
                                             constraints in refs/notes.md       [person]
                                             agent writes DESIGN.md prose       [model]
                 \                                   /
                  board freeze . [<id>]                                         [code]
                    render samples -> measure -> generated block
                    -> validate prose -> stamp vN -> archive board.vN-1
                    -> rewrite AGENTS.md and CLAUDE.md blocks
                                   |
                  agent composes outputs/<format>.html, declares vN             [model]
                                   |
                  board check / board kit -> check.json, kit-check.json         [code]
                                   |
                  board status   board diff   board log                         [code]
                                   |
                  brand feedback -> client's words -> DESIGN.md -> freeze again
```

**Adopting a site.** `board adopt .` finds the top-level HTML pages, a conventional build with an index page, files passed with `--page`, or the URLs of a running site, and captures each at desktop and mobile sizes. It writes screenshots and an `evidence.json` of computed styles, visible copy and candidate style sources (stylesheets, Tailwind configuration, theme and logo files) to `.briefatto/adoption/`. The agent reads them alongside the source and writes DESIGN.md from the site that exists. `board freeze .` then renders the same pages fresh and freezes v1. When the site needs tidying first, `board adopt . --check` runs the floor before anything else.

**Starting from a brief.** The agent saves the client's words to `brief.md` and the literal requirements to `essentials.json`. It captures live references with `board refs . --capture`, which hides cookie prompts and flags captures that did not settle or lost their images, and `board refs .` composes the sheet the client reacts to. The agent declares the audience's canvases in `formats.json` and draws three distinct directions as HTML samples, each with the brief's real copy, a designed wordmark and a recurring device marked `data-device`. `board directions .` renders each as a sheet, and the client points at one. Their words go into `refs/notes.md`, with musts and must-nots in fenced `constraint` blocks and the approval in a fenced `approval <id>` block. A first freeze requires that approval, or `--self-approved` for a developer acting as their own client. The agent writes DESIGN.md from the chosen samples, and `board freeze . <id>` stamps v1.

**Making pieces.** Each piece is standalone HTML under `outputs/` that declares its version, and `board check` runs the floor on any of them. `board kit .` checks the format-named pieces together with their campaign requirements and final exports, and writes `kit-check.json`, with the SHA-256 of every checked file, and a kit sheet. A brand change starts with the client's exact words, then an updated DESIGN.md and `board freeze . <id> --note "..."`. Earlier constraints carry forward, status names every piece to revisit, and the agent redraws them.

## What runs where

| Work | Runs in | Why there |
| :--- | :--- | :--- |
| Reading the brief, choosing references, drawing directions | The agent's model | Taste, which improves with every model |
| Reacting, picking, approving | The person | The pick is where intent becomes a fact |
| Writing DESIGN.md prose | The agent's model | Composition is carried in words the next model reads |
| Capturing, rendering, measuring | Code | A measured value is exact |
| Generated block and validation | Code | The guide never contradicts its samples |
| Stamping, archiving, instruction blocks | Code | Versions are files, reviewed in Git |
| Floor, campaign copy, export comparison | Code | Provable failures, the same in every style |
| Status, diff, log | Code | Repository truth, computed |
| Redrawing stale pieces | The agent's model | A redraw is design work |

## Why each boundary sits where it does

Taste stays in the model because the model improves and a rule list does not. We ship no taste rubric, since a hard score becomes the target and the work bends toward it. The deep layer of the brand, meaning composition, hierarchy and how a device recomposes on a tall canvas, is carried by the chosen samples and the prose, and the model reads them whole.

Measured values sit in a generated block because prose drifts and a render does not. The agent writes how the brand works. The board writes what the brand is, read from Chromium's computed styles, and validation binds the two together.

The client's words are stored verbatim, as fenced quotes for approvals and constraints. Code keeps them exact and carries them forward, and the model interprets them.

The floor runs on pixels because the failures live in pixels. Clipped headlines, fallback fonts and text over text show up only in a render. The source detector catches what code reveals, and the render catches the rest.

Versions live in files because Git is already the collaboration layer. A brand change is a commit: a stamped guide, a diff of measured values, a log entry. Review, branches and permissions apply unchanged.

Status reads a declaration because redrawing is a decision. A piece states its version, the board reports, the agent redraws, and the floor checks the result before it counts as current.

In a blind test on one real open-source project, Issue Composer, all four blind judges ranked the Briefatto Board kit first overall, ahead of Impeccable, Taste Skill and Hallmark. [See every kit side by side](https://briefatto.com/guides/impeccable-vs-taste-skill-vs-hallmark-blind-test/).

## Questions and answers

### What does `board freeze` write into DESIGN.md?

It leaves the agent's prose alone and writes a generated block between `<!-- briefatto-board:generated begin -->` and `<!-- briefatto-board:generated end -->`. That block holds the brand facts, the campaign copy and its sources, the client's verbatim musts and must-nots, and a computed-style table for every rendered sample. Freeze validates the prose against those values, then stamps the guide with its version, date and SHA-256 hash.

### How does Briefatto Board know a piece is stale?

Each piece says which version it was made under, with `<meta name="board-version" content="vN">`. `board status` compares that tag with the current board and lists each piece under `outputs/` as current, stale or unrecorded. If `board check` finds colours or fonts outside the current board, status reports that as well, along with the older version they came from.

### Who decides what looks good?

The agent's model makes every aesthetic decision, and the person picks the direction. The CLI renders, measures, records and checks what can be proven: text fit, loaded fonts, WCAG contrast, Impeccable's anti-pattern rules, the brief's literal copy and exports that match their source.

### What does `npx briefatto-board install` change in my repository?

It copies the skill and its launcher into `.claude/skills/briefatto-board/`, adds the package as a dev dependency, and writes a marked Briefatto Board block into `AGENTS.md` and `CLAUDE.md`. After the first freeze, that block tells every agent to read DESIGN.md before visual work, freeze brand changes and check every piece.

### What happens if DESIGN.md names a colour the samples never use?

The freeze fails. The report gives the line, the claimed value and the nearest value the samples actually render, with the sample it comes from, so the agent corrects the line and freezes again. Font families, font sizes and role-specific claims are held to the same rule.

### Which agents does Briefatto Board work with?

Any coding agent that reads `AGENTS.md` and runs shell commands, including Claude Code, Codex and Cursor. The board is a skill file and a CLI, and the brand lives in plain files in the repository, so every agent reads the same frozen guide.


More: [design principles](PRINCIPLES.md) · [the intent gap essay](https://briefatto.com/guides/intent-gap-design-principles/) · [design infrastructure for AI agents](https://briefatto.com/guides/design-infrastructure-for-ai-agents/)
