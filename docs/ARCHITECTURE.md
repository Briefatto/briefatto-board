# How Briefatto Board works: the architecture of the design layer for agents

Briefatto Board is a skill that tells an agent how to run a design process, plus a command-line tool that renders, measures, versions and checks everything that process produces. The agent's model makes every aesthetic decision, and deterministic code turns the chosen design into a stamped, versioned DESIGN.md, fails any piece that breaks the floor, and reports which pieces follow the current brand.

## One boundary

A design layer for agents has two jobs that pull in opposite directions. It has to leave room for taste, which lives in the model and improves every year. It also has to hold a brand fixed across sessions and agents for months on end, which only a program does reliably. We drew a hard line between those jobs. Judgement runs in the agent, while everything that can be measured or proven runs in code, on the rendered output, and lands in files in the repository. Every piece an agent makes crosses that line twice: the frozen guide constrains it before it is drawn, and code checks its render after. The [design principles](PRINCIPLES.md) argue for the line; what follows is how it is built.

## The parts

**The skill.** `SKILL.md` is the protocol the agent follows. It tells the agent to read a frozen DESIGN.md before any visual work, lays out both entries step by step, and marks the one place on the brief path where the agent stops for a person: the one comparison sheet of the three directions, where the person picks one, asks for changes or says 'you choose', with any missing fact asked in that same message.

**The CLI.** `npx briefatto-board` runs `install`, `adopt`, `refs`, `directions`, `freeze`, `check`, `kit`, `status`, `log` and `diff`. Every command that looks at a design renders it in headless Chromium through Playwright and reads computed styles, text geometry, font loading and contrast from the live page, on your machine.

**Install.** `board install` copies the skill and its launcher into `.claude/skills/briefatto-board/`, adds the package as a dev dependency, and writes a block between `<!-- briefatto-board:start -->` and `<!-- briefatto-board:end -->` into `AGENTS.md` and `CLAUDE.md`. Before a freeze, the block points the agent at the skill. After a freeze it carries standing rules: read `DESIGN.md` before any visual work, send brand changes through `board freeze`, and run `board check` on every piece before handing it over. They are plain text in the project, where every agent reads them.

**DESIGN.md and its generated block.** The guide has two authors. The agent writes the prose, which works as the handoff from one designer to the next: it names each recurring part by its job, says how it is built and how it recomposes on each canvas. `board freeze` writes what can be measured into a block between `<!-- briefatto-board:generated begin -->` and `<!-- briefatto-board:generated end -->`. For a brand started from a brief, that block holds the brand facts and campaign copy with the source of every line, and the client's musts and must-nots, quoted verbatim. For every sample it holds a table of each text role's font stack, size, weight, style and colour, plus every painted colour. Later freezes replace the block in place and leave the prose to the agent.

**Validation.** Freeze reads the prose against the render. Every colour, font family and font size the prose names must exist in the computed samples. A claim tied to a role, such as the colour of the price numeral, must match that role's measured values, and `data-board-role` names a role in a sample. Campaign copy must match its source exactly, and every referenced file, font load lines included, must resolve inside the project. A contradiction fails the freeze with the line number and the nearest real value.

**Stamps and the archive.** A passing freeze hashes the guide with SHA-256, records the hash in `board/board.json`, and stamps the guide after its front matter: `<!-- briefatto-board:freeze vN YYYY-MM-DD sha256:<hash> -->`. The new board is built in a staging directory under a lock. The previous `board/` becomes `board.vN` beside it, and the stage becomes current. Guide, instruction blocks and board directory move together, and a failure rolls all of them back. The board holds the rendered samples, `board.json` with the measured palette, type roles, radii, device and composition, a `tokens.css` of CSS custom properties, and a stylescape of the direction. A freeze with unchanged sources creates no version, and an archived guide is read back only while its hash matches its record.

**The render-and-check floor.** `board check` runs the open-source [Impeccable](https://github.com/pbakaus/impeccable) detector on the HTML source, then renders the piece at its canvas size and fails text that is clipped, off the canvas, over other text, or too small at the width where it is seen; fonts that never loaded; text below WCAG contrast; and story copy inside declared unsafe zones. Campaign pieces must carry the brief's required copy, body copy at reading size and supplied images. Every PNG and PDF in `deliverables.json` is decoded and compared with its HTML source. The receipt, `check.json`, lists every check that ran and every check skipped, with the reason.

**Status and diff.** Each piece declares its version in its head: `<meta name="board-version" content="v2">`. `board status` reads that tag from every piece under `outputs/` and reports it current, stale or unrecorded. When `board check` finds a piece using colours or fonts outside the current board, it names the version they came from, and status carries that finding while the piece's source is unchanged. `board diff v1 v2` compares measured values role by role. `board log` lists every version with its date, its note and how the first freeze was approved.

## The data flow

```
  EXISTING SITE                              NEW BRAND
  board adopt .                    [code]    brief.md, essentials.json          [person + model]
    pages at desktop and mobile              client references; optional
    -> .briefatto/adoption/                  board refs . --capture <url> <png> [code]
       screenshots + evidence.json           agent draws directions/<id>/       [model]
  agent reads captures and styles  [model]   board directions . -> one sheet    [code]
  agent writes DESIGN.md prose     [model]   one message: sheet + missing facts
                                             person picks or says 'you choose';
                                             refs/notes.md                      [person]
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

**Starting from a brief.** The agent saves the client's words to `brief.md` and the literal requirements to `essentials.json`. The client's references are recorded in `refs/manifest.json`. The agent's own research is captured with `board refs . --capture` and stays with the agent; the capture hides cookie prompts and flags pages that did not settle or lost their images. The agent declares the audience's canvases in `formats.json` and draws three distinct directions as HTML samples, each with the brief's real copy, a designed wordmark and a recurring device marked `data-device`. `board directions .` renders all three into one comparison sheet, a row per direction. The agent shows that sheet in one message that also asks for every missing fact, and the person points at one, asks for changes, or says 'you choose'. With no one to answer, the agent picks, names each missing fact at handoff and never invents one. The pick is the production approval. Their words go into `refs/notes.md`, with musts and must-nots in fenced `constraint` blocks and the approval in a fenced `approval <id>` block. A first freeze requires that approval, `--agent-picked "<reason>"` when the person handed over the choice, or `--self-approved` for a person acting as their own client. The agent writes DESIGN.md from the chosen samples, `board freeze . <id>` stamps v1, and the agent makes the kit. After an agent pick, the handoff shows the other two directions beside the kit, and a switch is one more version: `board freeze . <other-id> --note "Switch to direction <other-id>"`.

**Making pieces.** Each piece is standalone HTML under `outputs/` that declares its version, and `board check` runs the floor on any of them. `board kit .` checks the format-named pieces together with their campaign requirements and final exports, and writes `kit-check.json`, with the SHA-256 of every checked file, and a kit sheet. A brand change starts with the client's exact words, then an updated DESIGN.md and `board freeze . <id> --note "..."`. Earlier constraints carry forward, status names every piece to revisit, and the agent redraws them.

## What runs where

| Work | Runs in | Why there |
| :--- | :--- | :--- |
| Reading the brief and references, drawing directions | The agent's model | Taste, which improves with every model |
| Supplying facts, picking a direction or saying 'you choose' | The person | The pick is where intent becomes a fact |
| Writing DESIGN.md prose | The agent's model | Composition is carried in words the next model reads |
| Capturing, rendering, measuring | Code | A measured value is exact |
| Generated block and validation | Code | The guide never contradicts its samples |
| Stamping, archiving, instruction blocks | Code | Versions are files, reviewed in Git |
| Floor, campaign copy, export comparison | Code | Provable failures, the same in every style |
| Status, diff, log | Code | Repository truth, computed |
| Redrawing stale pieces | The agent's model | A redraw is design work |

## Why each boundary sits where it does

Taste stays in the model because the model improves and a rule list does not. We ship no taste rubric, since a hard score becomes the target and the work bends toward it. The deep layer of the brand, meaning composition, hierarchy and how a device recomposes on a tall canvas, is carried by the chosen samples and the prose, and the model reads them whole.

Measured values sit in a generated block because only a render reports exactly what was drawn. The agent writes how the brand works. The board writes what the brand is, read from Chromium's computed styles, and validation binds the two together.

The client's words are stored verbatim, as fenced quotes for approvals and constraints. Code keeps them exact and carries them forward, and the model interprets them.

The floor runs on pixels because the failures live in pixels. Clipped headlines, fallback fonts and text over text show up only in a render. The source detector catches what code reveals, and the render catches the rest.

Versions live in files because Git is already the collaboration layer. A brand change is a commit: a stamped guide, a diff of measured values, a log entry. Review, branches and permissions apply unchanged.

Status reads a declaration because redrawing is a decision. A piece states its version, the board reports, the agent redraws, and the floor checks the result before it counts as current.

In three blind tests on real open-source sites, the Briefatto Board kit came first with 4 of 4, 4 of 4 and 3 of 4 blind AI-model judges: on Issue Composer ahead of Impeccable, Taste Skill and Hallmark ([see every kit side by side](https://briefatto.com/guides/impeccable-vs-taste-skill-vs-hallmark-blind-test/)), on Pyxel ahead of Anthropic's frontend-design skill ([blind test 2](https://briefatto.com/guides/frontend-design-skill-vs-briefatto-board-blind-test/)), and on PocketBase above UI UX Pro Max ([blind test 3](https://briefatto.com/guides/ui-ux-pro-max-vs-briefatto-board-blind-test/)).

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

Every agent. The guide is a plain file in the project, the protocol is a plain skill file, and the work is done by a CLI any agent can call. Every agent reads the same frozen guide and runs the same checks.

## Export checks

Export the finished files and list every delivery PNG and PDF in project-root `deliverables.json`. Each entry names the actual file, its editable HTML source, and the exact comparison size in pixels. Use project-relative paths.

```json
[
  {"file":"delivery/card.png","html":"outputs/post.html","width":1080,"height":1080},
  {"file":"delivery/poster.pdf","html":"outputs/poster.html","width":1212,"height":1704,"pageSizeMm":{"width":303,"height":426}}
]
```

- Add `"transparent":true` for a transparent PNG. Use `viewport` with `width` and `height` when the HTML lays out at a different CSS size. Board scales the capture by the export width divided by the viewport width. Add `"fullPage":true` for a PNG of the full scroll height.
- PDF entries describe one page. Board rasterizes the page with PDF.js and compares it with the HTML in print media. The page aspect must fit within one comparison pixel on either axis. Optional `pageSizeMm` checks the visible page box to within 0.1 mm on each axis. Use the full page size including bleed when the visible page includes it.
- PNGs match their HTML pixel for pixel; PDFs match within a [rasterizer tolerance](#export-tolerance).

Run `board check .` to validate the listed files, or pass HTML filenames to run layout checks too. `board kit .` requires a frozen guide and includes the layout checks and final-file results in `outputs/kit-check.json`. Each export row records the SHA-256 of the checked bytes. Use independently renderable HTML as the source for each export. With no manifest, `board check` renders HTML previews. `board kit` checks the format-named PNGs alongside their HTML and creates one only if it is missing. Use `board render <file.html>` to regenerate these PNGs after editing the HTML.

## Export tolerance
A PNG must match every decoded RGBA pixel. Board ignores RGB values under fully transparent pixels. Lossless encoding of the same Chromium capture preserves these pixels exactly. PDFs allow a mean maximum-channel difference of 2 on a 0–255 scale and at most 2% of pixels differing by more than 32. In each 64 × 64 pixel tile, Board also compares pixels in both directions within one pixel of their position to account for rasterizer edge placement. The mean after this allowance must be at most 5. The A3 export measured 0.40 overall, 0.53% above 32, and 2.44 in the worst tile. A smaller type-and-vector PDF also passes. Removing a short date line stayed within the overall limits and exceeded the tile limit. The PDF regressions cover both scenarios.

More: [design principles](PRINCIPLES.md) · [the intent gap essay](https://briefatto.com/guides/intent-gap-design-principles/) · [design infrastructure for AI agents](https://briefatto.com/guides/design-infrastructure-for-ai-agents/)
