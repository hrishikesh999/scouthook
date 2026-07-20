# Sprint: Carousel Studio (Level 3 Editor)

**Goal:** Replace the read-only carousel-pack flow with a structured editor — Supergrow-class editing (per-slide content, live preview, brand kit, slide management) *plus* bounded design freedom (layout variants, element toggles) that Supergrow lacks. No free-form canvas.

**Positioning:** The editor exists to survive the "one slide is wrong" moment. Generation quality (Phase 5) remains the moat; the editor is table stakes done better.

---

## Current state (what we build on)

| Piece | File | Status |
|---|---|---|
| Pack data model | `migrations/064_carousel_packs.sql` | `carousel_packs` + `carousel_pack_slides` (roles: title/content/closing), `variable_map` with canonical slot names |
| Multi-slide template conversion | `services/carouselFromImages.js` | Image → HTML templates with shared reference set (CSS vars, slot names) |
| Render pipeline | `services/carouselPackRenderer.js` | AI extract → injectSlots → Chrome render service → PNGs + PDF, Redis job queue |
| Legacy splitter | `services/carouselGenerator.js` | Haiku chops post → Satori square slides → pdf-lib PDF |
| Native publishing | `services/linkedinPublisher.js:459` | LinkedIn Documents API fully wired (`carousel_pdf_url`) |
| Single-template editor | `public/editor.html` (~1570–1680) | Live iframe preview, slot form, AI fill, brand colors, manifest handling |
| Carousel UX today | `public/editor.html` `_selectCarouselPack` (~1681) | Extract → **read-only** slide summary cards → render → insert. **No editing.** |

**The gap:** everything between extraction and render is sealed. The single-template editing experience (iframe + slot form + brand colors) exists but is not applied per-slide.

---

## Target UX

Full-screen **Carousel Studio** modal, opened from the template gallery's Carousel section:

```
┌────────────┬──────────────────────────────┬─────────────────┐
│ Slide rail │   Active slide (live iframe)  │ Content | Design│
│ [1] cover  │                              │                 │
│ [2] stat   │   click-to-edit text slots   │ Content tab:    │
│ [3] list   │                              │  slot fields +  │
│ [4] quote  │   ┌ variant switcher ┐       │  AI actions     │
│ [5] cta    │   [A] [B] [C]                │ Design tab:     │
│  + Add     │                              │  brand kit,     │
│ (drag to   │                              │  font scale,    │
│  reorder)  │                              │  toggles: page# │
│            │                              │  swipe cue,     │
│            │                              │  byline         │
└────────────┴──────────────────────────────┴─────────────────┘
        [ Generate Carousel ]  →  render job  →  Insert in Post
```

---

## Core data model: the deck draft

Single JSON document, autosaved. The deck — not the post — is the unit of editing.

```json
{
  "version": 1,
  "pack_id": "uuid",
  "settings": {
    "aspect": "portrait",
    "theme": { "colors": { "--c-bg": "#0F766E" }, "fontScale": 1.0 },
    "decorations": {
      "pageNumbers": true,
      "swipeCue": true,
      "byline": { "enabled": true, "name": "…", "headline": "…" }
    }
  },
  "slides": [
    { "id": "s1", "template_id": "uuid", "role": "title",   "locked": false,
      "slots": { "headline": "…", "subhead": "…" } },
    { "id": "s2", "template_id": "uuid", "role": "content", "locked": true,
      "slots": { "headline": "…", "body": "…" } }
  ]
}
```

`locked` = user manually edited this slide; deck-level regenerate must not touch it.

---

## Phase 0 — Foundations (prereq, ~0.5–1 wk)

1. ~~Diagnose the gray-box render failure~~ **RESOLVED before this sprint** — diagnosed & fixed 2026-07-02: not a render bug; AI conversion emitted all color vars as `#cccccc` (detection + colorWarning + admin badges shipped for single templates). **2026-07-18:** the carousel pack path silently dropped `colorWarning` — now propagated: `carouselFromImages.js` returns per-slide `warnings`, `adminCarouselPacks.js` includes them in the done job, pack form shows a banner after the redirect.
2. **Migration 075:** ✅ DONE 2026-07-18 (`migrations/075_carousel_studio.sql`, **not yet applied — run `npm run migrate`**):
   - `carousel_drafts (post_id BIGINT FK→generated_posts, user_id, tenant_id, deck JSONB)` — one draft per post.
   - `carousel_packs.aspect_ratio` ('square'|'portrait') — derived from first slide's manifest dimensions at pack creation (`adminCarouselPacks.js`, with a pre-transaction column probe so it works before the migration is applied).
   - `html_templates.variant_group UUID NULL` — for Phase 4.
   - Portrait findings: render path was already aspect-aware end-to-end (`manifest.dimensions` → callRenderService; PDF pages sized per PNG; thumbnails fit-inside). Conversion prompt RULE 9 already maps portrait → 1080×1350; added a deterministic **dimension-mismatch warning** in `templateFromImage.js` (source aspect vs manifest aspect >5% → warn, joined into colorWarning). Admin upload hint now recommends portrait.
3. **Decorations overlay:** ✅ DONE 2026-07-18 — `appendDecorations()` in `carouselPackRenderer.js` (exported, smoke-tested): pill-style page numbers (skip cover), swipe cue (skip last slide, "swipe →" label on cover), byline with escaped name + data-URI avatar; scales with slide width; injected before `</body>` when `userOverrides.decorations` present, default off (backward compatible). Byline avatar sourcing from `linkedin_connections` wires up in Phase 1/2.
   **Bonus fix:** `renderCarouselPack` previously re-ran AI extraction on render and ignored client-provided content (double Haiku call; would have discarded Studio edits). Now uses provided `{title, content_slides, closing}` when present.

## Phase 1 — Deck API ✅ DONE 2026-07-18

Shipped:
- `services/carouselDeck.js` — `buildDeckFromExtract` (extract → deck with canonical slot keys, per-slide UUIDs + `locked` flags), `validateDeck` (structural errors throw 400 codes; value-level issues sanitize: hex validation, 600-char slot clamps, role/template membership + title-first/closing-last ordering), draft CRUD via `ON CONFLICT (post_id) DO UPDATE`. Unit-smoke-tested (build, round-trip validate, sanitization, 4 structural failure codes).
- `services/carouselPackRenderer.js` — render loop refactored into shared `_renderSlideQueue`; new `renderCarouselDeck` + `startCarouselDeckJob` (deck drives order/content/theme/decorations; byline auto-resolves workspace default LinkedIn identity + cached avatar). Same job store as pack jobs → existing `/api/visuals/jobs/:jobId` polling works unchanged.
- `routes/carouselDrafts.js` mounted at `/api/posts` (stacked after performance.js): `POST /:postId/carousel-draft` (idempotent create from extraction, Pro gate), `GET`, `PUT` (validated autosave), `POST …/render` (visual quota + logVisualGeneration).
- **Latent bug fixed:** `carouselPackRenderer` imported the db module namespace and called `db.prepare` on it (`db.js` exports `{db}`) — every `loadPack` call would have thrown `db.prepare is not a function`. The pack extract/render path likely never worked in production. Now `const { db, getSetting } = require('../db')`.

**Parity rule (unchanged):** server-side `templateSlotInjector` stays the single source of truth for slot injection; client previews reuse the single-template editor's injection logic.

> **BUILD STATUS 2026-07-18: ALL code phases complete (0–6). First batch committed c4946b3;
> second batch (Voice DNA, archetypes, entry point) follows.**
> Remaining is non-code: `npm run migrate` (075 + 076) · Phase 0.5 pack production (Canva) ·
> live end-to-end run (extraction → Studio → render → publish) · LinkedIn portrait-PDF verify.
> Deferred by choice: "write-from-topic" carousel (current entry point routes through an existing
> post + pack); analytics instrumentation.
>
> **Phase 5b (Voice DNA):** `extractCarouselPackContent` now prepends `buildSharedAuthorContext`
> (resolveProfile by post.tenant_id) — carousel copy uses the same voice+ICP context as every
> other generation path.
> **Phase 4b (archetypes):** migration 076 widens the role CHECK to add stat/list/quote/comparison/cta
> (content-class: swipeable middle, interchangeable with 'content'). carouselDeck CONTENT_ROLES +
> archetype-hint mapping in buildDeckFromExtract; planner emits an `archetype` field when the pack
> ships typed slides; legacy round-robin + Studio (isContent helper) + admin variant role list all
> archetype-aware. Backward compatible.
> **Phase 6b (entry point):** "Carousel" button in the editor visual action bar →
> `openHtmlTemplateModal({category:'__carousel__'})` → pack pick launches the Studio.
>
> **Brand mapping (admin parity with design templates):** after conversion, the carousel
> pack slide editor now shows a brand-role dropdown per color slot (bg/accent/text/…),
> seeded from the stored manifest, with a "Save brand mapping" button →
> `PUT /admin/carousel-packs/slides/:templateId/colors` (merges brandRole+default into the
> template manifest). Renderer parity: `resolveColorSlots` now honors `def.brandRole` via the
> shared `resolveBrandRole` (exported from templateRenderer), precedence
> override > brandRole > legacy default:'brand' > hex. Admin list SELECT returns slot_manifest.
>
> **Slide Polisher v1 (2026-07-19):** visual no-code editor for the last-10% conversion fixes,
> replacing raw-HTML editing as the primary polish path. `public/admin-slide-polisher.html`:
> click-to-select any element (pristine iframe — parent-side listeners, sandbox no-scripts),
> plain-language inspector (text/spacing/size+position/appearance/element ops), onion-skin
> overlay of the original upload (`GET /admin/html-templates/:id/original`, magic-byte sniffed),
> arrow-key nudge (absolute → left/top; in-flow → margins), undo stack, save via the existing
> versioned PUT. **Manifest guard:** docs lacking an embedded template-meta block get the DB
> manifest injected on load — otherwise the PUT's readSlotManifest would silently wipe slots/
> brand mappings and reset dims to square. Pack form's per-slide button now opens the Polisher
> ("✨ Polish slide"); raw editor remains an escape hatch inside it. Decision: build focused
> in-house tool over GrapesJS-class builders (component-model round-trip mangles script tags →
> would corrupt the manifest; whole-slide "Refine" stays deprecated).
>
> **Slide Polisher v2 (2026-07-20) — direct manipulation:** drag-to-move (positioned elements)
> + 8/3 resize handles, hand-rolled on the existing parent-overlay boxes (no library — Moveable
> rejected: cross-iframe + CSS-scale coordinate friction outweighs hand-rolling on our pristine-
> iframe architecture). Screen→canvas coords via `#pol-boxes` rect ÷ scale; position deltas map
> 1:1. Snap-to canvas edges/center (left/center/right, top/mid/bottom) with rose guide lines,
> 6px threshold; undo snapshot deferred until real motion (a plain click never dirties). Handles
> counter-scaled to stay constant on-screen at any zoom. Box-sizing-aware resize base (offsetW
> for border-box, computed width for content-box) prevents jump.
> **Onion-skin fix:** carousel conversion now stores each slide's uploaded source at
> `buildOriginalImageKey(templateId)` (main + variant paths) — the v1 onion-skin overlay and
> `GET :id/original` had no source for carousel slides before this; it silently always showed
> "no original".
> **Dropped:** element-scoped AI fix (user decision 2026-07-20) — direct manipulation is
> deterministic and pairs with the onion-skin; scoped AI still carries quality variance.

## Phase 2 — Studio UI ✅ DONE 2026-07-18 (code) ← MVP line

New `public/js/carousel-studio.js` (editor.html is 4.6k lines; do not grow it):
- **Slide rail:** scaled-down live iframes (same injected HTML as center canvas — guaranteed parity, no thumbnail renders). Drag-reorder content slides; title pinned first, closing pinned last. Duplicate / delete.
- **Center canvas:** active slide via existing `_renderTemplateIframe` mechanics, fit-to-height scaling.
- **Right panel:**
  - *Content tab* — reuse `renderHtmlTemplateForm` per active slide; edits update deck + re-inject iframe live.
  - *Design tab* — deck-level: brand colors (existing brand-color machinery → CSS var overrides on every slide), font scale, decoration toggles, aspect display.
- Autosave (1s debounce → PUT draft). Generate → existing job poll UI → existing `_doSaveCarouselPack` insert flow.
- Replace `_selectCarouselPack`'s read-only flow with Studio launch, behind a `carousel_studio` feature flag; old flow remains the fallback.

**Ship checkpoint:** Phases 0–2 alone = Supergrow parity (structured editing, live preview, brand kit, reorder, native publish).

Shipped: `public/js/carousel-studio.js` (self-contained IIFE, `window.CarouselStudio.open(packId)`) — slide rail (live scaled iframes, drag-reorder content slides, duplicate/delete/add), center canvas, Content/Design tabs, 1s-debounced PUT autosave with save badge, render job flow reusing `_doSaveCarouselPack` for insert. `GET /api/carousel-packs/:id` detail endpoint (slides + manifests + variable_map + variants). editor.html: script tag + `_selectCarouselPack` launches Studio (legacy flow kept as fallback). Preview = same template HTML + slot injection via iframe bootstrap script + client-side mirror of the decorations overlay.

## Phase 3 — Inline editing + per-slide AI ✅ DONE 2026-07-18 (code)

- **Click-to-edit:** `contentEditable` on `[data-slot]` elements inside the iframe; postMessage slot changes back to deck state (extend the existing template-editor postMessage API). Form fields and inline edits stay two views of the same deck state.
- **Per-slide AI actions:** Rewrite / Shorten / Punchier / Regenerate slide. New `mode: 'slide_rewrite'` in visuals route — Haiku call with the slide's slot manifest, word budgets, and Voice DNA context. Sets `locked: true` on manual edits; "Regenerate deck" skips locked slides.

Shipped: contentEditable inline editing on `[data-slot]` inside preview iframes (postMessage back to deck state, form fields stay in sync, no iframe re-render on keystroke). Per-slide AI actions (Rewrite/Shorten/Punchier) → `POST /:postId/carousel-draft/slide-rewrite` → `rewriteSlide()` in carouselDeck.js (Haiku, role-specific word budgets, only existing slot keys accepted, result persisted server-side). Manual edits set `locked: true`.

## Phase 4 — Layout variants ✅ DONE 2026-07-18 (code; needs variant designs)

- **Supply:** admin converts 2–3 alternate designs per role through `carouselFromImages` *into the same pack* — the reference-set mechanism already guarantees shared slot names, so variants are interchangeable by construction. Group them via `variant_group`.
- **UI:** variant switcher above the center canvas; switching swaps `template_id`, slots carry over losslessly.
- **Archetypes (stretch within this phase):** widen the `role` CHECK beyond title/content/closing → `stat`, `list`, `quote`, `comparison`, `cta`. Extraction prompt maps content to archetypes when the pack provides them; "Add slide" menu becomes an archetype picker. This is what makes decks look art-directed instead of one-template-repeated.

Shipped: `convertVariantImages` in carouselFromImages (converts against the pack's existing reference set → lossless slot carry-over by construction). Admin: `POST /admin/carousel-packs/:id/variants` + "Add layout variants" section in the pack form (role select, multi-upload, job progress, gray-box warnings). Variants link via `variant_group`, are NOT added to `carousel_pack_slides` (legacy round-robin unchanged). `loadPack` returns `variants` (guarded — degrades to none pre-migration); deck validation and deck render accept variant template ids; Studio shows a Layout A/B/C switcher when >1 same-role option exists. NOT done: archetype roles beyond title/content/closing (needs role CHECK migration + planner mapping — deliberate deferral).

## Phase 5 — Carousel-native narrative planner ✅ DONE 2026-07-18 (prompt layer)

The quality moat. Two entry paths:
1. **"Create a carousel"** in the creation flow — a planner that *writes for the swipe* from a topic/idea (not from a finished post): 3 cover options, one idea per slide, each slide ends with a swipe reason, payoff + CTA slide. Runs through `buildSharedAuthorContext` (Voice DNA + ICP resonance) like every other path.
2. **"Turn into carousel"** on existing posts — upgrade the splitter prompt from "chop into slides" to "re-plan as a swipe narrative."

Quality gate additions: per-slide word budgets (cover ≤ 8 words, body ≤ 30), integrity checks on deck copy.

Shipped: `extractCarouselPackContent` prompt rewritten as a swipe-native planner — narrative arc first (hook → promise → one idea/slide with momentum → payoff), cover ≤8 words, content slides ≤30 words each ending on an open loop, closing ≤25 words, voice-matching instruction; returns `title_options` (3 cover candidates, normalized so legacy consumers still get `title`). `buildDeckFromExtract` stores options in `deck.meta`; `validateDeck` carries meta through saves; Studio shows a cover-option picker on the title slide. NOT done: "Create a carousel" creation-flow entry point (write-from-topic rather than from-post) — needs a product placement decision; full Voice DNA context (`buildSharedAuthorContext`) not yet wired into the planner prompt.

## Phase 6 — Polish & instrumentation (~0.5 wk) — PARTIAL

- End-to-end verify portrait PDFs on LinkedIn (document processing, file size, mobile rendering).
- Analytics: studio opens, edit depth (slides touched, AI actions), generate/publish conversion.
- Launch content: 2–3 portrait packs with variants — **template supply is the real perceived-quality bottleneck; budget design time.**

---

## Sequencing & effort

**Decision (2026-07-18): template supply gates Studio work.** The admin module (pack form + carouselFromImages importer) already exists — "admin side first" means *producing packs*, not building admin code. Phase 0.5 comes before any Studio code: it validates the conversion + render path with real portrait content (flushing out the gray-box bug and square-first assumptions) and gives the Studio real templates to be designed against.

| Phase | Effort | Ships value alone? |
|---|---|---|
| 0 Foundations | 0.5–1 wk (bug is the unknown) | reliability |
| **0.5 Launch pack production** | ~1 wk design + import QA | **yes — packs improve the *current* flow immediately** |
| 1 Deck API | ~1 wk | no (enables 2) |
| 2 Studio UI | 1.5–2 wk | **yes — MVP, Supergrow parity** |
| 3 Inline + AI | ~1 wk | yes |
| 4 Variants/archetypes | ~1 wk + design | yes — the differentiator |
| 5 Narrative planner | ~1 wk | yes — the moat |
| 6 Polish | ~0.5 wk | launch |

Phase 0.5 scope: design 2–3 portrait 1080×1350 packs in Canva (each: title + 3–4 content layouts + closing; design ahead for Phase 4 by making content layouts visually distinct enough to become variants later). Import via the existing admin form, QA every slide's render + slot manifest, activate. Any portrait/aspect breakage found goes into Phase 0's migration work. Bonus: existing users get better packs in the current (pre-Studio) flow immediately.

Total ≈ 6–8 wks solo, but each phase after 2 is independently shippable. If content quality matters more than design agency for early users, swap Phases 4 and 5.

## Risks / open decisions

- **Gray-box render failure** is on the critical path (same render service). Diagnose before Phase 2.
- **Preview parity:** client injection must match `templateSlotInjector` — single-template editor already walks this line; add a parity test (render one slide server-side, diff against preview DOM text).
- **Decoration collisions** with existing template layouts — safe-margin convention only helps new templates; audit existing packs.
- **Square → portrait migration:** existing packs stay square; portrait needs new template designs (design investment, not code).
- **Decision:** allow users to change a content slide's *role/archetype* in place, or only via add/delete? (Recommend: only via add/delete — keeps slot mapping simple.)
