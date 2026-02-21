# ClawTab - Image Style Guide & Generation Prompts

## Visual Identity

**Color palette:** Indigo (#5c6bc0) as primary accent, lighter indigo (#7986cb) for secondary. Dark mode variant uses the same. Light gray (#f5f5f7) backgrounds, dark text (#1d1d1f). Small accent pops of teal, warm orange, or green for variety.

**App icon:** Indigo/purple rounded square with three white diagonal claw slash marks.

**Design system:** Clean, modern, system font stack. Professional macOS-native feel. The website is polished and minimal -- illustrations should add warmth and personality.

---

## Style Direction

Hand-drawn cartoon illustration with clean black outlines. Think Notion's editorial illustrations or Stripe's onboarding art -- simple, friendly, slightly whimsical without being childish.

- **Hand-drawn cartoon style** -- clean outlines (black or dark gray), simple colored fills, no heavy 3D or photorealism
- **Objects doing the talking** -- terminals, clocks, gears, robots, tmux windows, claw marks. Characters optional but keep them simple (dot eyes, minimal features)
- **Limited palette:** indigo (#5c6bc0), light indigo (#7986cb), dark navy (#1d1d1f), warm white (#f5f5f7), with small pops of teal (#0d9488), orange (#f59e0b), green (#22c55e), red (#ef4444) for accents
- **Clean black outlines** on all shapes, consistent line weight
- **White or very light gray backgrounds** -- images sit on light pages
- **Slightly whimsical proportions** -- oversized monitors, tiny clocks, big terminal windows, small sparkle/star decorations scattered around
- No text baked into images (except code-like snippets on terminal screens which are fine as decorative marks)
- Small sparkle/star accents (4-point stars) scattered for polish

**Mascot concept:** An original fantasy creature -- a small indigo wisp-critter with swept-back ear-fins, claws, and a wispy trailing body. Not a real animal. Speedy and capable but friendly. Appears across illustrations as the recurring character that runs your scheduled jobs.

**Texture:** Subtle paper/noise texture on backgrounds -- not flat white, more like warm off-white sketchbook paper. Gives illustrations a tactile, crafted quality.

**Characters:** The wisp mascot is the recurring character, but illustrations can also feature simple cartoon humans (dot eyes, minimal features, round heads, simple body shapes) interacting with terminals, scheduling jobs, etc. Humans add relatable context; the wisp adds brand personality.

**Prefix for all prompts (paste before each one):**

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Slightly whimsical proportions, friendly and approachable. Small sparkle/star decorations scattered around. No heavy shadows or 3D effects. Cartoonish and warm, like editorial magazine illustrations. Paper texture visible in the background.
```

---

## Mascot: The ClawTab Wisp

An original fantasy creature that appears across all illustrations. Not a cat, not a ghost -- something in between. File: `ign-dump/mascot-10a-angular-wisp.png`

**Design traits:**
- Sleek teardrop/bean body shape, wider at top, tapering into a wispy speed trail instead of legs
- Two angular swept-back ear-fins on top of the head, like they are catching wind
- Big expressive eyes (large white circles with big black pupils, slight confident squint), small friendly smirk
- Indigo (#5c6bc0) body with lighter purple (#7986cb) belly patch
- Three small sharp white claws on each of its two stubby arms -- the signature claw mark
- Wispy tail end has faint three-line claw scratch marks trailing behind it
- Floats slightly off the ground with a small shadow below
- Feels swift and capable but totally approachable and warm

**Mascot generation prompt:**

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, white background. Small sparkle/star decorations. No heavy shadows or 3D effects. Clean and modern. Character design: an original friendly mascot creature, slightly more angular and dynamic than a typical cute blob. Indigo (#5c6bc0) body with a sleek teardrop shape -- wider at the top, tapering down into a wispy speed trail at the bottom instead of legs. Two angular but friendly ear-like fins on top of its head, swept back like they are catching wind. Big bright expressive eyes (large white circles with big black pupils, slight confident squint), a small friendly smirk. Three small sharp white claws visible on each of its two stubby arms. The wispy tail end has faint three-line claw scratch marks trailing behind it, like it leaves claw marks wherever it goes. The creature floats slightly off the ground. It looks swift and capable but totally approachable and warm. Lighter purple belly patch. Tiny sparkle stars around. This is a creature that could be a sticker, an app icon, or a loading animation. Think Kirby meets a friendly phantom with cat ears. Centered on white background. Square aspect ratio.
```

---

## 1. Hero Background Image

**Size:** 1920x800px (wide panoramic)
**File:** `website/assets/hero-bg.png`
**Used:** Background of the hero section on the homepage, faded/translucent behind text

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Cartoonish and warm, like editorial magazine illustrations. Paper texture visible in the background. Wide panoramic scene: a cozy developer workspace from a slight overhead angle. A simple cartoon person sits at a big desk with an oversized MacBook showing terminal lines in indigo and green. The small indigo wisp-creature mascot (teardrop-shaped body with swept-back ear-fins, big expressive eyes, tiny claws, wispy speed trail instead of legs) floats beside the monitor, pointing at the screen cheerfully. Around the desk: a large analog clock with indigo hands, floating calendar cards, a steaming coffee mug, tiny gear icons, and small three-line claw scratch marks as decorative elements. Notification bubbles drift upward. The composition is spread wide horizontally with lots of breathing room. Airy and warm, elements spaced across the full width. Aspect ratio 2.4:1, very wide.
```

---

## 2. GitHub README Banner

**Size:** 1280x640px
**File:** `website/assets/github-banner.png`
**Used:** Top of GitHub README

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Cartoonish and warm, like editorial magazine illustrations. Paper texture visible. Centered composition: a macOS-style menu bar at the top with a small claw icon. Below it, three floating panels arranged in a fan -- a terminal window with green text lines, a clock/calendar showing a cron schedule, and a chat bubble representing notifications. The small indigo wisp-creature (teardrop body, swept-back ear-fins, claws, wispy trail) floats between the panels, tiny arms outstretched as if juggling them. A simple cartoon developer stands nearby with arms crossed, smiling confidently. Small sparkle stars around. Three diagonal claw scratch marks in indigo as a subtle watermark. Aspect ratio 2:1.
```

---

## 3. Docs Hero Illustration

**Size:** 600x300px
**File:** `website/assets/docs-hero.png`
**Used:** Top of the documentation page

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Cartoonish and warm. Paper texture visible. An open book lying flat with pages fanning out, showing terminal commands and config snippets as decorative colored lines. The small indigo wisp-creature (teardrop body, ear-fins, claws) sits on the book, holding a magnifying glass and reading intently. A simple cartoon person with glasses stands beside the book, pointing at a page. Floating above: small icons of a gear, a key, and a clock. A pencil and ruler nearby. Studious but friendly. Aspect ratio 2:1.
```

---

## 4. OG Image (Social Sharing)

**Size:** 1200x630px
**File:** `website/assets/og-image.png`
**Used:** Twitter/X cards, Discord embeds, LinkedIn previews, link unfurls

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Cartoonish and warm. Paper texture visible. Center composition: a MacBook screen showing a grid of job cards (colored rectangles with green, orange, indigo status dots). The indigo wisp-creature mascot (teardrop body, ear-fins, claws, wispy trail) sits on top of the laptop screen, legs dangling happily. Above the laptop, three icons float: a terminal bracket prompt, a clock, and a paper airplane. Three claw scratch marks in the top-right corner as a brand mark. A happy cartoon developer waves from behind the laptop. Professional but friendly. Aspect ratio 1.9:1.
```

---

## 5. Hero Section Character Illustration

**Size:** 400x400px
**File:** `website/assets/hero-wisp.png`
**Used:** Could replace or supplement the app icon in the hero section

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Cartoonish and warm. Paper texture visible. The ClawTab wisp mascot in a confident hero pose: indigo teardrop-shaped body, swept-back ear-fins, big bright eyes with a confident squint, friendly smirk. One stubby clawed arm on hip, the other holding up a glowing indigo orb (representing a running job). Wispy speed trail at the bottom instead of legs. Three-line claw scratch marks behind it like a brand watermark. Sparkle stars around. Floats above a tiny shadow. Centered, square aspect ratio.
```

---

## 6. Empty State / Getting Started Illustration

**Size:** 400x300px
**File:** `website/assets/empty-state.png`
**Used:** In the app when no jobs are configured yet, or in docs "Getting Started" section

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Cartoonish and warm. Paper texture visible. The small indigo wisp-creature (teardrop body, ear-fins, claws, wispy trail) floats next to a large empty clipboard/checklist. A simple cartoon person stands on the other side, scratching their head with a thought bubble showing a lightbulb. A glowing plus-sign button floats nearby, inviting action. A small clock and gear icon on the ground. Encouraging, simple, minimal. Aspect ratio 4:3.
```

---

## 7. Error/Failure State Illustration

**Size:** 400x300px
**File:** `website/assets/error-state.png`
**Used:** When a job fails, or in error documentation

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, on a warm off-white paper texture background with subtle grain/noise. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of red (#ef4444) and orange for accents. Cartoonish and warm. Paper texture visible. The small indigo wisp-creature (teardrop body, ear-fins, claws) looking at a terminal window that shows a red X mark, with a slightly worried expression (eyebrows tilted up). It holds a tiny wrench, ready to fix things. A simple cartoon person stands nearby, rolling up their sleeves to help. Small warning triangles and a broken gear icon. The terminal has a crack in its frame. Still friendly and approachable despite the error theme. Aspect ratio 4:3.
```
