# Email Channel SOP

> Fill in the [FILL IN] placeholders during Phase 7 Day 5.
> The Content sub-agent reads this when drafting email content.

## Subject line guidelines

- 40–60 characters — fits most mobile preview panes.
- Avoid spammy words: "free", "guaranteed", "act now", "limited time".
- Use curiosity or specificity: state the one thing the email does for the reader.
- No all-caps. No excessive punctuation (!!!).

## Preheader

- 85–100 characters.
- Must complement the subject, not repeat it.
- Give the reader a second reason to open.

## Body structure

1. **Hook** (1–2 lines) — mirror the subject promise.
2. **Context** (1 paragraph) — why this matters to the reader right now.
3. **Core content** — one idea, well-developed. For newsletters: 3–5 items max.
4. **CTA** — single, clear, above the fold on mobile.

## HTML rendering notes

- Email clients strip most CSS. Use inline styles; no flexbox or grid.
- Max width: 600px.
- Buttons: use `<table>` with background-color; `<a>` elements with padding.
- Images: always include `alt` text; some clients block images by default.

## Send-time heuristics

- B2B SaaS: Tuesday–Thursday, 10 AM–12 PM recipient local time.
- Avoid Monday mornings and Friday afternoons.
- [FILL IN: override once you have 3+ months of send data]

## Tone

- Same as brand/voice.md, but slightly warmer — email is a more personal channel.
- Avoid passive voice.
- Write to one person, not a list.

## Unsubscribe handling

- Never suppress unsubscribes manually.
- High unsubscribe rate (>0.5%) signals misaligned content or frequency — flag to Analyst.

## Audience segments

- [FILL IN: HubSpot list ID for the main broadcast list]
- [FILL IN: HubSpot list ID for "engaged — opened in last 90 days"]
- Default to main broadcast for campaign emails; use engaged segment for re-engagement sequences.
