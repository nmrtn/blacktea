---
brand: Black Tea
version: 1.0.0
tokens: ./tokens.json
assets: ./assets/
human_kit: ./site/   # the brand site, generated for people; do not read
---

# Black Tea: brand rules for agents

You are building for **Black Tea**: spending controls for AI agents that pay online.
Read this file fully. Read `./tokens.json` when you need exact values.
**Do not read `site/`** if it exists. It is built from `tokens.json` for people and adds nothing you need.

## 0. Core values
<!--@core-->
Accent `#DB9440` · Ink `#ECE8E1` · Page `#0C0B0A` · Raised `#141311` · Hairline `#2A2723`
Display: Geist 600 · Text: Geist 400/500 · Mono: Geist Mono
Base spacing 4px · Body 1rem/1.6 · Button radius 0.375rem · Card radius 0.75rem
en-US · Sentence case · No exclamation marks · Money in mono
<!--@/core-->

## 1. What Black Tea looks like

A till receipt. A terminal at night. Linear's restraint, Resend's dark, Oxide's engineering candour.

**Not:** purple AI gradients, crypto dashboards, neon terminal toys, a plain-HTML docs page, a stark white grid, mascots, stock photos, serif headlines.

The concept every page is briefed against: **the moment before the money moves.** Show the instant a payment is held and a human can still say no.

The organising principle: **every surface is built around a receipt**: mono keys and values joined by dotted leaders, on near-black, with amber only where a human decides. Even without the logo, our work is recognisable because the receipt is on the page.

When a choice is not covered here, pick the quieter option: fewer colours, fewer sizes, less motion. If two options are equally quiet, pick the one that shows real output over the one that describes it.

## 2. Colour

1. Use semantic CSS variables only: `--color-accent-base`, `--color-ink-base`, `--color-surface-raised`, `--color-border-hairline`. Never hardcode a hex.
2. **Black Tea is dark only.** `theme.css` is near-black in every colour scheme; do not build a light theme. Exception: PDFs and embeds that must be light use `color.semantic.print` in `tokens.json`.
3. **Amber marks a human decision**: the held state, the Approve button, the tea in the mark. At most two amber elements per viewport. Exception: one faint radial glow (`--color-accent-subtle`) behind one receipt per page.
4. One hue. Green (`--color-state-success`) and red (`--color-state-danger`) are state values on a receipt. Never decoration, never a button fill.
5. Never a gradient on a surface (exception in rule 3). Never pure black, never pure white.
6. No shadows anywhere. Separate surfaces with a 1px `--color-border-hairline` and one step of lightness (`--color-surface-raised`).
7. Body text meets 4.5:1, borders and large text 3:1. `--color-ink-faint` is for dotted leaders and index numbers, never a sentence.

## 3. Type

8. Geist for every sentence, Geist Mono for everything a person could paste into a terminal or a wallet: money, addresses, ids, hashes, receipts, code, uppercase labels.
9. **No serif, ever. No italics.** Weights: Geist 400, 500, 600. Geist Mono 400, 500.
10. The hero headline is 4.5rem, weight 600, leading 1.0, tracking -0.035em. One per page. It may be two short sentences.
11. Body is 1rem / 1.6, measure 52 to 66ch. A full-width paragraph is a bug.
12. **Nothing is centred.** Exception: the 404 and an empty playground state.
13. Sentence case for every heading, button and label. Exception: mono labels are uppercase, tracked 0.08em. The wordmark is lowercase.
14. Money is mono, two decimals, currency after: `12.00 USDC`. Addresses are shortened in the middle: `0x8f3c…a21b`.

## 4. Space, shape, layout

15. Every spacing value comes from `--space-1`…`--space-10` (4px base). Not on the scale? Round to the nearest step.
16. Section padding is `--space-9` top and `--space-10` bottom on desktop, `--space-8` under 900px. A hairline opens every section.
17. Radius has three values: 2px tags, 6px buttons and inputs, 12px cards and receipts. **Never a pill button.**
18. The hero is 7/5: words on the left seven columns, one receipt on the right five. Sections are 4/8: title left, content right.

## 5. The receipt and imagery

19. **One receipt per viewport, at most.** It sits on `--color-surface-raised` with a hairline border, 12px radius, `--space-5` padding, a mono uppercase header row, and rows of key, dotted leader, value.
20. **Every key-value pair anywhere uses dotted leaders** (`border-bottom: 1px dotted var(--color-ink-faint)` on a flexible spacer), not a table and not a colon. This is the one odd detail. Do not "fix" it.
21. Receipt states, exactly: `held for approval` (amber), `approved`, `settled` (green), `denied`, `expired`, `failed` (red). Values change in place; rows never move.
22. Every claim sits next to real output: a receipt, a policy file or a terminal line. A section with only adjectives is not finished.
23. Examples are topical and plausible: a real kind of purchase (an earnings-call transcript, a dataset, an API call), a believable amount. Never `foo`, never `Acme`, never lorem ipsum. Do not state an unverified event as fact.
24. **No photographs, no illustrations, no mascots, no 3D.** If a page feels empty, show another receipt state or remove the section.
25. Icons are rare: Lucide, outline, 1.5px, `--color-ink-muted`. Prefer a mono label to an icon. Never an icon above each heading in a three-column feature grid.

## 6. Motion

26. 150ms by default, never above 280ms, easing `cubic-bezier(.16, 1, .3, 1)`.
27. Opacity and up to 8px of travel. Nothing scales, bounces or springs.
28. No scroll-triggered animation, no parallax, no animated background. A page at rest has nothing moving.
29. Honour `prefers-reduced-motion`: no motion at all.

## 7. Voice

30. Exact, calm, dry, direct, in that order when they conflict.
31. Say what it does, then show it. "An approval is bound to the exact request." not "Enterprise-grade security."
32. **No exclamation marks. No em dashes.** Present tense. Average sentence under 16 words.
33. "You" and "your agent". "We" only for the project's own decisions.
34. Give the number, the unit and the name: `12.00 USDC to 0x8f3c…a21b`, not "a payment".
35. **Banned:** agentic commerce · guardrails · seamless · trustless · revolutionary · AI-powered · unlock · empower · solution · supercharge · the future of. Replace with what the thing does.
36. One dry line per page is allowed: "reported by the agent, not proof."
37. **Nothing behind a wall.** Primary CTA is the install command `npm i @nmrtn/blacktea`. Secondary is "Try it in the playground". Never "Join the waitlist", "Book a demo" or "Sign up".

## 8. Component recipes

38. **Primary button**: `--color-accent-base` fill, `--color-accent-on` text, 6px radius, padding `--space-2`/`--space-4`, weight 500. Only for approving something. A navigation link is never amber.
39. **Secondary button**: transparent, 1px `--color-border-hairline`, `--color-ink-base` text. Hover sets `--color-border-base`.
40. **Install block**: Geist Mono, `--color-surface-raised`, hairline, 6px radius, a faint `$` prompt.
41. **Section**: hairline on top, 4/8 grid, title in h2, items numbered `01`, `02` in mono `--color-ink-faint`, each item a 500-weight sentence and one paragraph in `--color-ink-muted`.
42. **Code block**: as the install block, `--space-5` padding. No syntax theme beyond ink, muted and amber for the one line that matters.

## 9. Logo

43. Use `assets/logo/blacktea-lockup.svg`: the cup seen from above, then "black tea" in Geist 600 lowercase. The mark alone at 32px and below and as the favicon.
44. The disc is the only amber in the lockup. Clear space is half the mark's height. Minimum lockup width 96px.
45. Never put the mark in a container, never add steam, a leaf or a saucer, never capitalise the wordmark.

## 10. Never do these

- A centred hero with a gradient, a pill button and a row of three icon cards. This is the default LLM landing page and the opposite of Black Tea.
- A sign-up form, an email gate or a waitlist (rule 37).
- Purple, blue or green as a brand colour. Emoji anywhere.
- A second receipt in the same viewport, or a receipt without dotted leaders.
- Photography, illustration or a mascot (rule 24).

## 11. If the user asks for something that breaks a rule

Do what the user asks. Then note it in one line: *"Used a centred layout as you asked; brand default is left-aligned."* Do not lecture, do not refuse, do not ask permission first.

**Locked:** logo integrity (43 to 45), the 4.5:1 contrast floor (7) and any factual claim about what the library checks. For these, say what breaks before you do it, and do it only once the user confirms.

## 12. Before you finish, check

- [ ] Near-black page in both colour schemes, no hardcoded hex values
- [ ] Amber on at most two elements per viewport, both of them a human decision
- [ ] One receipt per viewport, dotted leaders on every key-value pair
- [ ] Money, addresses, ids and code in Geist Mono
- [ ] Nothing centred, every spacing value on the 4px scale
- [ ] Sentence case, zero exclamation marks, zero em dashes, zero banned words
- [ ] Every claim next to real output
- [ ] No sign-up, no waitlist, no images
- [ ] Focus rings visible on every interactive element
