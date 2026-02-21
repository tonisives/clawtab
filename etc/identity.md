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

**Mascot concept:** A small, friendly robot helper -- round body, simple dot eyes, antenna, indigo-colored. It appears across illustrations as a recurring character that "runs" the scheduled jobs. Think of a tiny indigo robot butler that manages your automation.

**Prefix for all prompts (paste before each one):**

```
Hand-drawn cartoon illustration with clean black outlines, simple colored fills, white background. Limited color palette: indigo (#5c6bc0), light purple (#7986cb), dark navy, white, with small pops of teal, orange, or green for accents. Slightly whimsical proportions, friendly and approachable. Small sparkle/star decorations scattered around. No heavy shadows or 3D effects. Clean and modern.
```

---

## Mascot: The ClawTab Robot

A small, friendly indigo robot that appears across all illustrations:
- Round/boxy indigo body with lighter indigo accents
- Simple dot eyes (white circles with black dots), small antenna
- Short stubby arms and legs
- About the size of a coffee mug relative to objects in the scene
- Expression is always helpful and busy -- carrying things, pressing buttons, checking clipboards

---

## 1. Hero Background Image

**Size:** 1920x800px (wide panoramic)
**File:** `website/assets/hero-bg.png`
**Used:** Background of the hero section on the homepage, faded/translucent behind text

```
A wide panoramic scene showing a clean desk workspace from above at a slight angle. On the desk: an oversized MacBook with a terminal window showing colorful code lines, a large analog clock with indigo hands showing cron-style tick marks, small floating calendar cards and notification bubbles drifting upward. A tiny indigo robot sits on the laptop keyboard, waving. Scattered around: tiny gear icons, small claw scratch marks as decorative elements, a coffee mug with steam. The composition is spread wide horizontally with lots of breathing room. Very clean and airy, elements spaced out across the full width. Light gray background fading to white at edges.
```

---

## 2. GitHub README Banner

**Size:** 1280x640px
**File:** `website/assets/github-banner.png`
**Used:** Top of GitHub README

```
A centered composition showing a macOS menu bar at the top with a small claw icon. Below it, three floating panels arranged in a fan: a terminal window with green text lines, a clock/calendar showing a cron schedule, and a chat bubble representing Telegram notifications. A tiny indigo robot stands between the panels, arms outstretched as if juggling them. Small sparkle stars around. Three diagonal claw scratch marks in indigo as a subtle background watermark. Clean, centered, plenty of white space.
```

---

## 3. Docs Hero Illustration

**Size:** 600x300px
**File:** `website/assets/docs-hero.png`
**Used:** Top of the documentation page

```
An open book lying flat with its pages fanning out, but the pages show terminal commands and configuration snippets (as decorative colored lines). A small indigo robot sits on the book, reading with a magnifying glass. Floating above: small icons of a gear, a key (for secrets), and a clock. A pencil and ruler nearby. Clean workspace feel, studious but friendly.
```

---

## 4. OG Image (Social Sharing)

**Size:** 1200x630px
**File:** `website/assets/og-image.png`
**Used:** Twitter/X cards, Discord embeds, LinkedIn previews, link unfurls

```
Center composition: a MacBook screen showing a grid of job cards (colored rectangles with status dots -- green, orange, indigo). Above the laptop, three icons float in a row: a terminal bracket prompt, a clock, and a paper airplane (Telegram). The small indigo robot sits on top of the laptop screen, legs dangling. Three claw scratch marks in the top right corner as a brand mark. Indigo color accents throughout. Professional but friendly. Plenty of breathing room.
```

---

## 5. Hero Section Character Illustration

**Size:** 400x400px
**File:** `website/assets/hero-robot.png`
**Used:** Could replace or supplement the app icon in the hero section

```
The ClawTab robot mascot in a hero pose: standing confidently with one hand on hip, the other holding up a glowing indigo orb (representing a running job). The robot has a round indigo body, white dot eyes, a small antenna with a blinking light, and stubby arms and legs. It wears a tiny tool belt. Small sparkle stars around it. Three claw scratch marks behind it like a logo backdrop. Centered, clean white background.
```

---

## 6. Empty State / Getting Started Illustration

**Size:** 400x300px
**File:** `website/assets/empty-state.png`
**Used:** In the app when no jobs are configured yet, or in docs "Getting Started" section

```
The small indigo robot standing next to a large empty clipboard/checklist. The robot is looking up at it with a thought bubble showing a lightbulb. A plus-sign button floats nearby, inviting action. A small clock and gear icon sit on the ground beside the robot. Encouraging, simple, minimal.
```

---

## 7. Error/Failure State Illustration

**Size:** 400x300px
**File:** `website/assets/error-state.png`
**Used:** When a job fails, or in error documentation

```
The small indigo robot looking at a terminal window that shows a red X mark. The robot has a slightly concerned expression (eyebrows tilted). It holds a wrench in one hand, ready to fix things. Small warning triangles and a broken gear nearby. The terminal has a crack in its frame. Still friendly and approachable despite the error theme.
```
