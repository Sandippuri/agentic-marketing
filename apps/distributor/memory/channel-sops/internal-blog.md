# Internal Blog Channel SOP

> Fill in the [FILL IN] placeholders during Phase 5 Day 4.
> The Content sub-agent reads this when drafting blog posts for /blog/<slug>.

## Article structure

1. **Title**: 50–70 characters. Specific over clever. Keyword-first for SEO where natural.
2. **Intro** (100–150 words): State the problem. Who it's for. What they'll leave with. No fluff.
3. **Body sections** (H2 headings): One idea per section. 200–400 words per section. Use examples and code/data snippets over abstractions.
4. **Conclusion** (100 words max): One-sentence summary → single CTA.
5. **CTA**: Specific. "Book a demo" or "Read [related post]" — not "Get in touch".

## Length

- Target: 800–1,500 words for most posts.
- Long-form (how-to, ultimate guide): 2,000–3,500 words only if the topic warrants depth.
- Never pad. If the idea is 500 words, write 500 words.

## Headings

- **H1**: Title only (auto-generated from `title` field).
- **H2**: Section headers. Must make sense standalone — readers scan.
- **H3**: Sub-points within a section. Use sparingly.
- No H4 or deeper.

## Links

- External links: open in a new tab. Max 3–5 per post to avoid link rot.
- Internal links: always link to related posts or the product page when relevant.
- Canonical URL: auto-set to `/blog/<slug>`.

## Images

- **Cover/OG image**: 1200×630. Always set. Use the generated asset if available.
- **Body images**: screenshots, diagrams, or charts only — no stock photography.
- Always include descriptive alt text.

## Markdown conventions

- Code blocks: fenced with language identifier.
- Bold: for key terms and calls-to-action. Not for decoration.
- Italics: sparingly — for titles, technical terms, or genuine emphasis.
- Lists: when there are 3+ parallel items; not for things that read naturally as prose.

## SEO

- Include the primary keyword in the H1 (title) and first H2.
- Meta description auto-generated from the first 155 characters of the intro.
- Slug auto-generated from title — review for readability.

## Syndication (after publish)

The Distributor automatically posts a syndication card to the originating thread with:
- ✅ Success message with the live URL.
- 📋 Syndication checklist: Medium, Substack, Hashnode, Dev.to — paste instructions included.
Wait 24–48 hours before syndicating to let the canonical URL index.

## Quality bar

- Every technical claim must be verifiable.
- Every "we" claim ("we reduced X by Y%") must be real and already public.
- If uncertain, use "teams using this approach" instead of a first-person claim.
