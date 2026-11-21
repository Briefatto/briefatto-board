# Design principles

Software got its infrastructure in version control, tests and review. Design for agents gets it from Briefatto Board.

We built the board on three decisions: taste belongs to the model, the floor belongs to code, and the brand belongs to the repository. Together they are the architecture a design layer for agents needs, and every command in the board follows from them.

## The problem is intent

Every agent designs now, and drawing a good page is solved. Agents take an idea straight to running software with no canvas in between, so a design system's first reader is now an agent, which executes it on every piece. The same agent drew a good landing page today and a different good one tomorrow, from the same brief, and neither of them was the brand. What went missing was one person's intent, kept intact from the idea to the pixels and through every session that came after.

On its way to the screen, intent passes through four steps and loses something at each handover.

| Step | What it holds | Loss on the way in |
| :--- | :--- | :--- |
| Human intent | What the person sees in their head | |
| Design brief | That intent put into words | Loss of expression |
| Agent's interpretation | The brief as the model reads it | Loss of understanding |
| Rendered design | The pixels that ship | Loss in execution |

Then the next session starts from the brief and draws something else. That loss, continuity, compounds with every session, and it is why we call today's AI design a slot machine. Each pull can pay out a great page, nothing ties one pull to the next, and anyone who wants a brand is left pulling again and choosing by hand. A better prompt only reaches the loss of expression, and a better model still starts every session from zero. Making agents better designers leaves continuity where it was.

Designers never closed this gap with better words. They pinned up references, showed options as pictures, and waited for the client to put a finger on one and say "this one". Briefatto Board makes that practice the protocol an agent runs.

| Designer's practice | Board step | Loss it closes |
| :--- | :--- | :--- |
| Collect references | `board refs` builds the sheet the client reacts to | Expression |
| Show options as pictures | `board directions` renders three directions on the real canvases | Understanding |
| Point at one | The client's exact approval is recorded with the pick | Understanding |
| Write the brand guide | `board freeze` stamps a versioned DESIGN.md | Continuity |
| Check the work | `board check` renders every piece against the floor | Execution |
| Track the brand | `board status` and `board diff` | Continuity |

## Taste belongs to the model

Aesthetic judgement lives in the model inside your coding agent, and that model gets stronger every year. We built the board so that every gain in the model becomes a gain in your design on the day the model ships.

We ship no taste rubric, and the reason is mechanical. A fixed rubric caps a stronger model at the taste of whoever wrote the rules. It also becomes the target, because an agent optimises what it is scored on. That is Goodhart's law, and its end state is work that passes every score after losing what made it good.

So the board gives the model what a great designer gives a strong colleague: the brief, the references, the client's pick and the brand guide. Then the model designs, and the people who use the picture judge it whole.

## The floor belongs to code

A headline cut off at the edge is wrong in every style. Failures like that are never a matter of taste, and the board checks exactly those, in a real browser render, on every piece:

- Text that is clipped, off the canvas, over other text, or too small at the size it is seen.
- Fonts that never loaded, down to the weight and style each piece uses.
- Contrast below WCAG.
- The anti-patterns found by [Impeccable](https://github.com/pbakaus/impeccable)'s open-source detector.
- The brief's literal facts: the brand name and the required copy.
- Delivery: every exported PNG and PDF is decoded and compared pixel by pixel with its editable HTML source.

Each check is objective and matters for every model that will ever exist, since a stronger model still needs its text to fit. When models improve, nothing in the floor is rewritten.

## One brand, held across every agent



`board freeze` records the brand's source wording and the exact styles from a fresh render, validates the written guide against them, and stamps a new version. Claude Code, Codex, Cursor, Copilot and Gemini CLI read that DESIGN.md before any visual work. Each piece declares the version it was made under, so after a brand change `board status` names every stale piece and `board diff` shows what moved.

## The repository is the brand system

DESIGN.md is a file in your repo, under the collaboration system code already runs on. In Git, review, pull requests, permissions and history apply to the brand exactly as they apply to code.

A brand change becomes a pull request. The reviewer reads the new guide, `board diff` shows what moved, and `board log` records who decided and when. `board freeze`, `board diff` and `board status` add brand versions on top of the workflow you already trust, and the brand travels with the code it styles: clone the repo and you have the brand.

## Proof

In a blind test on the open-source project Issue Composer, all four judges ranked the Briefatto Board kit first overall, ahead of Impeccable, Taste Skill and Hallmark. Our kit carried no taste rubric. The model made every call, while the board held the brand and its floor caught what code can prove.

[See every kit side by side](https://briefatto.com/guides/impeccable-vs-taste-skill-vs-hallmark-blind-test/).
