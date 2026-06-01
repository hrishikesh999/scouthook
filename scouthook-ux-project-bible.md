# ScoutHook UX Project Bible
## Postiv AI Competitive Analysis + ScoutHook Redesign Plan

> **How to use this file:** Attach this document at the start of every design session with Claude. It contains the complete competitive teardown of Postiv AI (47 screens), all UX design principles for ScoutHook, and the full proposed screen list. Reference it by section name when asking Claude to design specific screens.

---

## 1. Project Context

### What ScoutHook is
A LinkedIn content tool for consultants, coaches, and freelancers. The core promise: upload your documents, reports, and ideas — ScoutHook turns them into LinkedIn posts that win clients. Unique differentiators:
- **Document vault** (PDFs, URLs, YouTube, newsletters) — no competitor does this as a core feature
- **40+ pattern quality gate** — posts checked before the user sees them
- **Voice fingerprinting** — learns how you write
- **Lead signals** — captures who comments as warm leads
- Branded carousel generation
- Full scheduling + LinkedIn publishing

### What Postiv AI is (the competitor)
A LinkedIn AI agent with an "Agent Bob" mascot. Chat-first creation (user types prompts → AI generates). $99/month. 500+ creators. Strong onboarding wizard, good inspiration feed, weak analytics, zero lead capture. The most advanced competitor in the space.

### The one strategic truth
ScoutHook's biggest differentiator (document vault) must be the hero, not a feature. The biggest untouched gap in the market — turning LinkedIn content into a pipeline of leads — is what Postiv's own users are asking for and not getting.

---

## 2. Postiv AI — Complete Screen Inventory

### FLOW A: Onboarding Wizard
*6-step fullscreen wizard — no sidebar, complete focus. Separate from main app.*

---

**Screen A1 — Onboarding Step 1: Setup**
- File: `onboarding-step-1.png`
- Step indicator: 1 of 7 (Setup → Cadence → Team → Plan → Activate → Connect → Live)
- Bob mascot holding boxes with headline: "Start with your LinkedIn and website."
- Subtext: "I'll fill the company details and build your plan from there."
- Two inputs: LinkedIn profile URL (pre-filled from OAuth), Company website URL
- On company website entry: AI auto-detects company → shows "COMPANY DETECTED — Copypower" badge with Edit link
- Optional details accordion (collapsed by default)
- Footer note: "We will build from Copypower and your LinkedIn profile."
- Primary CTA: **"Build my plan"** (not "Continue" — this is a product promise)
- Bottom: "Signed in as rishi@copypower.co · Wrong account? Log out"
- **Key insight:** Minimal input, maximum AI output. Company name auto-detected. CTA is a promise.

---

**Screen A2 — Onboarding Step 2: Cadence**
- File: `onboarding-step-2.png`
- Step 1 checked. Currently on Step 2.
- Bob mascot with headline: "Pick the days."
- Subtext: "I'll create a viral post planning. Never stare at a blank post box again."
- Day picker: M T W T F S S toggles (M, W, F selected by default)
- Live feedback below picker: "3 posts/week, Mon, Wed, Fri, **12 slots this month**" (blue text on slot count — creates momentum)
- Time picker: Morning (9:00) / Midday (12:00) / Evening (17:00) / Custom pick — card-style selection
- Back + **"Next →"** CTAs
- **Key insight:** "12 slots this month" is motivational framing — makes the schedule feel like opportunity, not obligation.

---

**Screen A3 — Onboarding Step 3: Team**
- File: `onboarding-step-3.png`
- Step 3: Team
- Bob mascot with headline: "Pick the size."
- Subtext: "With a team plan you can onboard everyone on your team to build a personal brand."
- 3 cards: Just me (1 seat) | Small team (up to 3 seats) | Growing team (up to 20 seats, "BEST VALUE" badge)
- "Just me" selected by default
- Optional: "Invite teammates" email field (comma-separated)
- Back + **"Continue"** CTAs
- **Key insight:** Team upsell built into onboarding. Frictionless — just click a card.

---

**Screen A4 — Onboarding Step 4: Plan ("Doing my homework")**
- File: `onboarding-step-4.png`
- Step 4: Plan
- Bob mascot with headline: "Doing my homework."
- Subtext: "Pulling together everything I need to write like you."
- Processing checklist (live ticking):
  - ✅ Gathering your public LinkedIn posts
  - 🔄 Analyzing your top competitors (in progress)
  - ○ Reading your website content
  - ○ Extracting your brand design system
  - ○ Studying your voice and tone
  - ○ Drafting your first content plan
- Footer: "This usually takes a few seconds."
- No buttons — user watches AI work
- **Key insight:** This is the single best screen in Postiv. Pure trust-building theater. Makes the AI feel like it's doing real work. Users feel the product earning its price. ScoutHook must have an equivalent.

---

**Screen A5 — Onboarding Step 5: Activate (Pricing)**
- File: `onboarding-step-5.png`
- Step 5: Activate
- Bob mascot with headline: "Lock in the plan."
- Subtext: "Your first month is already drafted. 7 days free. One-click cancel anytime."
- Plan tabs: Creator Pro (1 seat) | Team Light (3 seats) | Team Pro (20 seats)
- Selected plan card (dark blue): Creator Pro, **$0 today**, then $99/mo billed monthly
- Monthly/Yearly toggle (Yearly shows -60% badge)
- Feature list: Posts, carousels & infographics · AI planner · Scheduling · Priority support
- Primary CTA: **"Activate the plan, 7 days free, cancel anytime →"**
- Trust badges: Secure checkout by Stripe · 14-day money-back guarantee · Trusted by 500+ creators
- Reminder note: "We'll remind you 48h before the trial ends."
- Testimonial: Katelin O'Shea, Founder at AI That Works Ltd. (specific time savings mentioned)
- FAQ accordion below (Getting Started, Creating Content, LinkedIn Integration, Team, Technical, Best Practices, Pricing, Troubleshooting)
- **Key insight:** Pricing shown only AFTER the AI has done visible work. "$0 today" is the dominant message. Trust badges handle every objection.

---

**Screen A6 — Onboarding Step 6: Connect LinkedIn**
- File: `onboarding-step-6.png`
- Step 6: Connect. Trial now activated.
- Bob mascot (celebrating) with headline: "You're in. Trial activated."
- Subtext: "One last thing and I can start publishing for you."
- "What I'll do" checklist:
  - ✓ Publish scheduled posts at your times
  - ✓ Pull analytics so the plan gets smarter
  - ✓ Never post without your preview & approval
- Primary CTA: **"Connect LinkedIn"** (LinkedIn blue button)
- Green safety callout: "Zero risk to your account. Postiv uses LinkedIn's official OAuth, the same green-lit flow as Buffer or Hootsuite. Account bans only come from unofficial tools that scrape the site or ask for your email + password. Revoke access in one click, anytime."
- Skip link: "Skip for now, I'll connect later"
- **Key insight:** The account safety objection — the biggest fear in the LinkedIn tools category — is handled proactively and specifically. This is exactly the right copy at the right moment.

---

### FLOW B: Dashboard & App Shell

**Screen B1 — Dashboard / Home**
- File: `Dashboard-1.png`
- Headline: "What are you creating today?"
- User avatar at top center
- 5 action cards in a grid:
  - Make a post (Create engaging LinkedIn posts)
  - Make a carousel (Design professional carousels)
  - Schedule manually (Plan and schedule your content)
  - Get inspiration (Discover content ideas with AI)
  - Add more knowledge (Expand AI knowledge base)
- Section: "Get Started with Postiv AI" + embedded walkthrough video (8 min 27 sec, 3 min watch)
- Massive FAQ section with 8 accordion categories: Getting Started, Creating Content, LinkedIn Integration, Team & Collaboration, Technical Questions, Best Practices, Pricing & Plans, Troubleshooting
- Bottom: "Still Have Questions?" → Chat with our team | Free Onboarding Call
- Navigation sidebar: Home · Agent Bob · Create Content · Analytics · Schedule · Inspiration · Knowledge Base · Feedback · Settings · Refer Friends
- **Key weakness:** This is a support page dressed as a dashboard. Zero user data, zero activity, zero personalization. No streak, no next scheduled post, no vault document count.

**Sidebar Navigation (persistent)**
- Icons only (collapsed): Home · Agent Bob · Create Content · Analytics · Schedule · Inspiration · Knowledge Base · Chat bubble · Settings · Refer Friends (gift) · User · Archive
- Light/Dark/Desktop mode toggle at bottom
- Collapsible to icon-only or expanded with labels

---

### FLOW C: Content Studio (Core Creation)

**Screen C1 — Studio Empty State**
- File: `create-post.png`
- Header: "Studio — Create LinkedIn posts and carousels"
- Top-right: + New chat | Chats | Drafts | Support
- Center: Time-aware greeting — "Night owl mode, Rishi / The quiet hours are the creative hours."
  - Also seen: "The night is young / Let's get tomorrow's content ready while the ideas flow."
- 3 generic prompt suggestions (clickable pills):
  - Create a post about AI trends
  - Design a carousel about productivity
  - Announce a product launch
- Bottom: Chat input "Tell me what you want to create... Use @ to tag a file"
- User avatar (with online green dot) + profile selector dropdown + microphone + attachment (+) icons
- Send button (grayed until input)
- **Key weakness:** Suggestions are generic, not connected to user's uploaded documents. No "create from vault" option visible.

---

**Screen C2 — Studio: Post Generating**
- File: `create-post-generation-chat-interface.png`
- User message bubble (top right, dark blue): "Create a post about AI trends"
- AI response area showing work in progress:
  - 💭 Thought for 1s
  - 🔍 Searched all knowledge for "AI trends 2026" ⓘ
  - ✏️ Generated hook
  - ✅ Created LinkedIn Post card: "AI Trends 2026" by Hrishikesh Jobanputra
- Chat input still active at bottom
- **Key insight:** "Searched all knowledge for X" transparency builds trust. Users can see the AI is using their vault.

---

**Screen C3 — Studio: Inspiration Attached Before Generating**
- File: `Inspration-to-post.png`
- Time greeting: "Night owl mode, Rishi"
- 3 prompt suggestions visible
- Below suggestions: Attached inspiration post card showing:
  - Anupam Mittal (LinkedIn) — post preview text
  - 5.6k reactions · 454 comments
  - × close button
- Below card: "Content attached for context"
- 3 quick action chips: **"Create similar post"** | **"Extract key insights"** | **"Contrarian take"**
- Chat input active (focused, blue border)
- **Key insight:** The inspiration-to-post path. One click from the inspiration feed attaches a post as context with 3 smart action chips. Elegant.

---

**Screen C4 — Studio: Inspiration Generating**
- File: `Inspration-to-post-1.png`
- User message (dark blue bubble): "Analyze the key insights from this content and create a thought-provoking LinkedIn post" + attached Anupam Mittal card
- AI working: 💭 Thought for 3s → 🔍 Searched all knowledge for "Gen Z work learning skills car..." → ✏️ Generated hook → 💭 Thinking...

---

**Screen C5 — Studio: Split View (Chat + Editor)**
- File: `create-post-genreation-options.png` and `post-preview-editor.png`
- Left panel: chat conversation (narrowed)
- Right panel: post editor slides in with title "Gen Z and the Learning-First Career Shift — LinkedIn Post"
- Editor top tabs: Desktop | Mobile | **Schedule** | Copy
- Rich text toolbar: Undo/Redo · Bold · Italic · Strikethrough · Bullet/Numbered list · Arrow · Dot · Curve · Box · Emoji · Tag
- Post preview area: Profile photo + name + tagline + post body text
- Post body (example): Strong hook, data points with → arrows, narrative close, engagement question
- Below post: dashed box with 3 options — **Add Image** | **Add Carousel** | **Attach Existing**
- Character count: "977 / 3000" + green "Saved" indicator bottom right
- **Key insight:** No quality gate visible. Post just appears. No hook type label. No explanation of why this hook was used.

---

**Screen C6 — Studio: Attachment Menu**
- File: `create-post-generation-chat-interface-attachment.png`
- Popup menu above + icon: Upload image | Pick from library | Carousel AI images (Beta toggle)

---

**Screen C7 — Studio: Drafts Modal ("Continue Where You Left Off")**
- File: `add-content-draft.png`
- Modal overlaid on blurred background
- Tabs: Posts (1) | Carousels
- Filter row: Status (Drafts) | Creator (You/Rishi) | Tag (All tags)
- Draft card: "AI Trends 2026" — preview text — Draft status · May 15, 10:06 PM · Rishi
- Delete (trash) + Open (→) icons per card

---

### FLOW D: Inspiration

**Screen D1 — Personalize Feed Modal**
- File: `Inspiration-feed.png`
- Overlaid on app (sidebar visible)
- Title: "Let's Personalize Your Feed"
- Info callout: "Why do we need this? Your interests help us show you the most relevant LinkedIn inspiration right from the start. As you interact with content, we'll learn even more about what you like."
- Large text area: "Tell us about your interests and expertise"
- Placeholder: "Example: AI entrepreneur building customer support solutions with focus on automation, SaaS growth, and user experience optimization..."
- Character counter: 0/500 · Minimum 20 characters
- "You can update your interests anytime in Settings > AI Context"
- Primary CTA: **"Save & Continue"**

---

**Screen D2 — Inspiration Feed**
- File: `Inspiration-feed-1.png`
- Dense LinkedIn-style post list (2-column grid)
- Each post card: avatar · name · follow status · post text preview · image/video if attached · engagement counts (reactions, comments) · small action buttons
- Filter bar at top: Topics | Creators | Post types | Following · Filters button
- Very dense — many posts visible at once
- Small "Use to post" button on each card
- **Key weakness:** Extremely dense, no breathing room, hard to scan. No connection to user's own document topics.

---

**Screen D3 — Schedule Post Modal (from Studio)**
- File: `schedule-post.png`
- Full overlay modal: "Schedule LinkedIn Post — Schedule your post for publishing"
- LEFT COLUMN:
  - Attach Media (Optional): Carousel | Images | Upload Video tabs
  - Schedule Post section: Platform dropdown (LinkedIn/Hrishikesh Jobanputra), Date field (16/05/2026), Time field (09:00 AM)
  - Tags section
  - "Already Scheduled" label + mini calendar showing May 2026 with scheduled dates highlighted in blue
- RIGHT COLUMN: Preview (Desktop/Mobile toggle) showing full post with author card
- Bottom: Cancel + **"Schedule Post"** (primary blue)

---

**Screen D4 — Carousel Picker Modal**
- File: `upload-carousel.png`
- Triggered from within Schedule modal
- Title: "Select a Carousel — Choose a carousel to schedule for LinkedIn"
- Search bar: "Search carousels by title or content..."
- Tabs: Existing Carousels | **Upload Custom PDF** (active)
- Upload PDF area: "Upload your own PDF and attach it as a LinkedIn carousel document." + Upload PDF button
- Cancel + **"Use Custom Carousel"** CTAs

---

### FLOW E: Knowledge Sources / Document Vault

**Screen E1 — Add Knowledge Source: Type Picker**
- File: `add-knowledge-source.png`
- Modal: "Add Knowledge Source — Select a source type"
- 6-card grid:
  - 🌐 Website — "Crawl and monitor websites for content"
  - ✉️ Newsletter — "Import content from email newsletters"
  - 💼 LinkedIn Profile — "Your company page or teammates **not on Postiv**"
  - 👥 Competitors — "Track competitor LinkedIn profiles for inspiration"
  - ▶️ YouTube — "Import transcripts from YouTube videos"
  - N Notion — "Sync pages from your Notion workspace"
  - </> API — "Push content via API from your own integrations"
- **Key weakness:** "Competitors" is listed here AND inside Foundation. API shown to non-technical users.

---

**Screen E2 — Add Knowledge Source: Website**
- File: `add-knowledge-source-website.png`
- Title: "Add Knowledge Source — Configure Website"
- Website URL field (required, marked with red asterisk)
- Include Paths (Optional): "Only crawl pages that match these paths. Leave empty to crawl all pages." Example: /blog/*, /articles/*
- Exclude Paths (Optional): "Skip pages that match these paths." Example: /admin/*, /login/*
- Blue info callout: "How website crawling works: We crawl the website and extract text content · Content is checked for relevance before being added · You can remove anything that doesn't fit"
- Back + **"Create Source"** (grayed until URL entered)
- **Key weakness:** Include/Exclude paths is too technical for target audience.

---

**Screen E3 — Add Knowledge Source: LinkedIn Profile**
- File: `add-knowledge-source-linkedin.png`
- Profile Type picker: **Personal Profile** (selected, "Individual LinkedIn profile") | Company Page ("LinkedIn company page")
- LinkedIn Profile URL field (required)
- Blue info callout: "Best for your **company page** or **teammates not using Postiv**. For competitors, use the Competitors section in Foundation instead."
- Back + **"Create Source"** (grayed)

---

**Screen E4 — Add Knowledge Source: Newsletter**
- File: `add-knowledge-source-newsletter.png`
- Newsletter Forwarding Address: green box showing unique email address (e.g., 5wjkj8@sources.postiv.ai) + Copy button
- "How to use:" numbered instructions: 1. Copy the email above · 2. Subscribe to newsletters using this address, or · 3. Set up email forwarding from your existing newsletters
- Approved Senders (Optional): "Only import newsletters from these email addresses or domains. Leave empty to accept all." + input + add button
- Back + **"Create Source"**

---

**Screen E5 — Add Knowledge Source: YouTube**
- File: `add-knowledge-source-youtube.png`
- YouTube Channel URL (required): placeholder "https://www.youtube.com/@channelname"
- Blue callout: "Best for adding **your own YouTube channel** to learn from your video content. Video transcripts will be imported as knowledge for your agent."
- Back + **"Create Source"** (grayed)

---

**Screen E6 — Add Knowledge Source: Notion**
- File: `add-knowledge-source-notion.png`
- Large centered card: Notion logo + "Connect Notion" + "Connect your Notion workspace to sync pages as knowledge sources" + **"Connect Notion"** button (OAuth)
- Back + "Create Source" (grayed until connected)

---

**Screen E7 — Asset Library**
- File: `Asset-library.png`
- Title: "Asset Library — Manage and organize all your creative assets"
- Top-right actions: Add Website | Import from Notion | Upload Asset
- Filter tabs: All Assets · Websites · PDFs · Images · YouTube · N (Notion) · Both
- Sort/filter dropdowns: All Sources | Newest First
- View toggle: grid/list
- Empty state: upload icon + "No assets found — Start building your library by uploading your first asset." + Upload Asset button
- **Key weakness:** This is separate from the Knowledge Source flow. Users have two places to find uploaded content — confusing duplication.

---

### FLOW F: Agent Bob (AI Brain Configuration)

**Screen F1 — Agent Bob Setup (Checklist)**
- File: `Agent-bob-1.png`
- Header tabs: Setup 1/3 · Plans · Activity · Sources · Foundation
- Left panel: Bob mascot illustration + "Meet Bob — Your AI content agent" + description
- Right panel: "Finish setting up Bob — 1/3 done"
- 3 checklist items:
  1. **Connect LinkedIn** (CTA button active) — "Choose the profile(s) you want to write for. This unlocks profile-specific tone and foundation settings."
  2. **Fill foundations** (Locked 🔒) — "Tell us your business, audience, and voice." Note: "Connect LinkedIn to unlock foundation settings."
  3. **Add knowledge sources** ✅ Done — "Add another source →"
- Bottom tip: "After you add sources, the first sync can take a moment. You'll see new items appear in Activity."

---

**Screen F2 — Foundation: Business Tab (Empty)**
- File: `Agent-bob-foundation.png`
- Two sections: Organization Foundation (shared) | Profile Foundation (per-LinkedIn profile)
- **Organization Foundation tabs:** Business | Audience & Competitors
- Fields: Website URL (with Autocomplete button) · Business Name · Language · Country · Business Description (2000 char limit)
- **Profile Foundation** (below):
  - Per-profile tab: "Hrishikesh Jobanp..."
  - Content Goal: 4 cards — Establish thought leadership · Generate leads · Attract talent · Custom goal
  - Posting Schedule: posts/week · time · timezone · day toggles (M T W T F S S)
  - Writing Style: "Learn from LinkedIn Posts" (Extract Style button) | "Upload Writing Samples" (accordion)
  - Saved Memory: "The AI will save preferences and instructions here as you chat."
  - Custom Instructions (optional): free text, 2000 chars

---

**Screen F3 — Foundation: Business Tab (Filled)**
- File: `Agent-bob-foundation-2.png`
- Same layout as F2 but filled with real data
- Business Description: Long detailed description of CopyPower Media (email marketing agency) — 1397/2000 chars
- Content Goal: one selected
- Posting Schedule: 7 posts/week at 09:00 AM, Calcutta, M W F selected (note: shows "Select 4 more days" error — inconsistency with 7 posts/week but only 3 days selected)
- Writing Style: "Extract Style" button active (has LinkedIn posts to learn from)
- Writing Samples: "Found only 0 posts. Need at least 3 original posts for style analysis."

---

**Screen F4 — Foundation: Audience & Competitors Tab**
- File: `audience-competitors.png`
- **Competitors section:** Add website or LinkedIn profile URL → AI discovers their LinkedIn presence, key employees, content
- **Target Audience section:** Pre-fill button (AI auto-fills based on website)
  - Roles: e.g., CTOs, Founders
  - Industries: e.g., SaaS, Healthcare
  - Pain Points: e.g., Spending hours creating content without results
- Profile Foundation section below (same as F2 — repeated on this tab too)

---

### FLOW G: Schedule

**Screen G1 — Schedule Page**
- File: `schedule-page.png`
- Header: "Schedule" + Today/week nav + + Add Post + Filters
- Week planner header: "May 11–17, 2026 · 1 posts across 0 open slots · GMT+5:30"
- Week calendar grid: Time column (8:00–18:00) × 7 days
- One post visible: Friday May 15 at 9:00 — "Gen Z and the Learning-First..." card with Scheduled tag + Text tag + profile avatar
- Post card shows: time, post type icon, truncated title, status badge, content type tag, author avatar
- **Overview section (below calendar):**
  - 3 stat cards: 1 Scheduled · 0 Open slots · 0 Approvals
  - "No published posts this week yet."
- **Content mix** donut chart: educational (100%, blue dot)
- **Post slots** section: "Hrishikesh Jobanputra · 3/week · All cadence slots are filled."
- **Top posters:** Rishi · 1
- **Upcoming Posts list:** Gen Z post · 16/05/2026 at 09:00 · Scheduled · Text badges

---

**Screen G2 — Schedule Post Modal**
- File: `schedule-post.png`
- Full overlay modal (with sidebar visible)
- LEFT COLUMN:
  - "Attach Media (Optional)" section — tabs: Carousel | Images | Upload Video
  - "Schedule Post" section:
    - Platform dropdown: "LinkedIn (Hrishikesh Jobanputra)"
    - Date: 16/05/2026 (date input)
    - Time: 09:00 AM (time input)
    - Tags section with "Tags" pill
  - "Already Scheduled" calendar: May 2026 mini calendar, scheduled dates highlighted blue
- RIGHT COLUMN:
  - Preview toggle: Desktop | Mobile
  - Full post preview in LinkedIn card style (author + content)
- Bottom: Cancel + **"Schedule Post"** (primary)

---

**Screen G3 — Carousel Picker Modal**
- File: `upload-carousel.png`
- Modal within modal (layered over Schedule modal)
- Title: "Select a Carousel — Choose a carousel to schedule for LinkedIn"
- Search bar: "Search carousels by title or content..."
- Tabs: Existing Carousels | Upload Custom PDF (active)
- Upload state: "Upload your own PDF and attach it as a LinkedIn carousel document." + Upload PDF button
- Cancel + **"Use Custom Carousel"** (grayed until file selected)

---

### FLOW H: Settings

**Screen H1 — Settings: General**
- File: `Settings-1.png`
- Tabs: **General** · Organisation & Team · AI Writing Settings · AI Inspiration · LinkedIn Accounts · Integrations (+ Carousel Template — scrolls off)
- **User Profile section:** Full Name (editable) · Email Address (locked, "Contact support to change your email address")
- **Plan Information section:** Plan badge: "Pro Plan — Trial, 7d left" · "Trial ends 22 May 2026. Then $99/month." · "Start subscription now" link · Manage billing button
- Save Changes button (bottom right)

---

**Screen H2 — Settings: AI Writing Settings**
- File: `AI-writng-settings.png`
- LinkedIn Profile picker at top (per-profile settings)
- **Authority Statements:** "Add credibility hooks and expertise statements" — up to 10 statements
- **Call to Actions:** "Add CTAs to use at the end of posts" — up to 10 CTAs
- **Content Principles:** "Define your content philosophy and messaging approach" — up to 20 principles
- **Your Products:** "You haven't added any products yet. Add one so the AI can mention your offerings naturally in content." — up to 5 products
- **Postiv AI Rules:** "Custom AI instructions" — 2000 char freetext
- **Saved Memories:** "Memories the AI has saved from your conversations" — Import memories link · empty state

---

**Screen H3 — Settings: AI Inspiration**
- File: `AI-inspirations.png`
- LinkedIn Profile picker
- **Your Interests:** "Tell us about your interests and expertise" — 500 char text area (filled: "SaaS and Email marketing")
- **Tracked Creators:** "Track LinkedIn creators to see their content boosted in your inspiration feed. When you add a creator, everyone benefits from their content!" — URL input + Add Creator button — empty state: "No tracked creators yet."
- Save AI Inspiration button

---

**Screen H4 — Settings: LinkedIn Accounts**
- File: `LinkedIn-accounts.png`
- **LinkedIn Accounts section:**
  - Connected account card: "LinkedIn — Publish posts directly to LinkedIn" · Profile photo · "Connected as Hrishikesh Jobanputra" (green badge) · email · Connection expires: Jul 14, 2026 · Postiv user: You
  - Actions: Refresh Connection | Approvers | Disconnect (red)

---

**Screen H5 — Settings: Integrations**
- File: `integrations.png`
- **Public API section:** "Use your organization API key to send company knowledge directly into the knowledge base." · API Key field · Generate API Key button · View API Docs button · Warning: "Keep this key secret."
- **Notion Integration:** Connect Notion workspace to import pages (OAuth)
- **Webhooks:** Post Publication Webhooks (Beta) — "Get a webhook notification when a new post is live on LinkedIn" · Add Webhook button

---

**Screen H6 — Settings: Carousel Template**
- File: `carousel-template.png`
- LinkedIn Profile picker
- **Import carousel style section:** "Show us a carousel style to learn from — Upload a PDF, screenshots, or an HTML file and we'll turn it into a reusable style for Hrishikesh Jobanputra."
  - Choose source button + "Choose a source first" CTA
  - File size notes: PDFs and ZIPs up to 20MB, images up to 10MB
- Empty state: "No template saved — Create a carousel and save it as a template from the editor."

---

**Screen H7 — Settings: Organisation & Team**
- File: `organiation-teams.png`
- **Organizations section:** "Copypower" — Current · owner badge · 1 member · Joined 15/05/2026 · Invite button
- **[Org Name] Members section:** "Manage team members, seats, and invitations." + Invite Member button
- **Seat Usage:** Progress bar — 1/1 seats · "All seats are assigned." (full bar shown as warning)
- **Upgrade prompt:** "Need more seats? Contact Carolina to add extra seats." + Chat with our team button
- **Members list (1):** Rishi · You · Owner badge · email · ✓ Seat assigned · LinkedIn connected · Remove Seat action

---

### FLOW I: Feedback

**Screen I1 — Feedback Board**
- File: `feedback-board.png`
- Title: "Feedback Board — Help us build what matters to you"
- Submit Feedback button (top right)
- Tabs: Open Requests | Released
- Filter: All · Features · Bugs · Improvements · Most Voted sort
- Top voted requests:
  1. **Custom carousel templates** (6 votes) — Improvement — "Ability to save design as a template and use premade style templates"
  2. **Auto-plug comment on LinkedIn posts** (6 votes) — Feature — "I want to automatically have a comment be placed so I can include a link after a while."
  3. **Future planning** (5 votes) — Improvement — "Ability for Bob to plan future weeks rather than just the current one"
  4. **Company page posting** (5 votes) — Feature
  5. **Tags in posts** (4 votes) — Feature — "Tag people/company pages direct from Postiv"
  6. **Engage with my audience from Postiv** (4 votes) — Feature — "Have it be where I can respond to comments straight from Postiv"
  7. **Not showing data** (1 vote) — Bug — "Engagement data (best times to post) do not appear to be showing any data whatsoever."
  8. **Data Analysis Narratives** (1 vote) — Feature

**Screen I2 — Submit Feedback Modal**
- File: `feedback.png`
- Category: Feature Request | Bug Report | Improvement (pill selection)
- Title field: "Short summary of your feedback"
- Description textarea: "Tell us more about your idea or issue..." (with microphone input option)
- Cancel + Submit Feedback CTAs

---

### FLOW J: Welcome Email

**Screen J1 — Welcome Email**
- File: `postive-AI-welcome-email.png`
- Subject: "Welcome to Postiv AI 🎉 Let's get your first posts created"
- From: Postiv AI noreply@postiv.ai
- Opening: "You just joined the hundreds of business owners who are finally solving their LinkedIn consistency problem."
- Subhead: "Your next 30 minutes will change your LinkedIn game forever."
- **5 activation steps with screenshots:**
  1. **Upload Your Expertise** — "Drop in any content where you share your knowledge: Client case studies · Business presentations · Strategy documents · Email sequences"
  2. **Add your tone of voice instructions** — Via Settings → AI Context → Postiv AI Rules. Warning: "Do NOT upload your tone of voice instructions in the content library."
  3. **Update your AI profile** — Go to Settings → LinkedIn styling. Add: Authority statements · CTAs · Content Principles
  4. **Generate Your First Posts** — 5 specific prompt templates to copy-paste:
     - "Help me create a post about [specific lesson] from my recent work with [client/project]"
     - "Take this [document] and help me turn it into a LinkedIn post"
     - "Help me write a post about [current trend/challenge] in [your industry]"
     - "Help me create a post about the biggest mistake I see [Relevant topic]"
     - "I want to share what I learned from [recent project/experience]"
  5. **Watch the Magic** — "Posts AI will create posts that sound like you because they're based on YOUR expertise."
- CTA: **"Go to Postiv AI"** button
- Personal note: "Tomorrow I'll show you how to turn any post into a professional carousel in under 2 minutes."
- Signed: Carolina Puerma, Co-Founder @ Postiv AI
- P.S.: "If you have any reply, just reply to this email. I personally respond to every message within 24 hours."

---

## 3. What Postiv Does Well — Steal These Patterns

| Pattern | Screen | Why it works |
|---|---|---|
| "Build my plan" CTA | A1 | Product promise, not form button |
| Company auto-detect from URL | A1 | Instant gratification, removes friction |
| "12 slots this month" framing | A2 | Makes schedule feel like opportunity |
| Time-aware Studio greeting | C1 | Human, memorable, sets tone |
| "Doing my homework" processing | A4 | Trust-building theater — makes AI feel real |
| LinkedIn safety objection handled | A6 | Exactly the right copy at the right moment |
| Source type picker grid | E1 | Scannable, visual, immediately obvious |
| "Searched all knowledge for X" | C2, C4 | Shows AI using your content — trust signal |
| Inspiration → 3 quick action chips | C3 | Create similar / Extract insights / Contrarian take |
| Split view chat + editor | C5 | Power users love seeing both simultaneously |
| Live preview Desktop/Mobile | G2 | See exactly what it looks like before publishing |
| Schedule calendar shows existing posts | G2 | Context-aware — see what's already scheduled |
| Per-profile settings | F2, H2 | Critical for agencies |
| Public feedback board | I1 | Community trust signal |
| Co-founder personal email | J1 | Extreme retention and activation tool |
| 5 copy-paste starter prompts | J1 | Removes blank page anxiety immediately |
| Autocomplete from website URL | F2 | Reduces setup friction enormously |
| $0 today → then $99 framing | A5 | Minimize the payment psychological barrier |
| 14-day money-back + Stripe badge | A5 | Trust signals at the exact right moment |

---

## 4. What Postiv Does Poorly — Beat These

| Problem | Severity | Evidence | ScoutHook opportunity |
|---|---|---|---|
| Setup gates value behind configuration | 🔴 Critical | Agent Bob checklist locks steps | Show generated post BEFORE asking for full setup |
| Dashboard is a FAQ page | 🔴 Critical | Dashboard-1.png — zero user data | Real activity dashboard: streak, next post, vault count |
| Chat-first requires knowing what to ask | 🔴 Critical | Studio empty state has generic prompts | Document-first: pick from vault → AI proposes post type |
| No quality gate visible | 🔴 Critical | Post just appears, no check shown | Surface the 40+ pattern check as a confidence badge |
| Hook type never shown or explained | 🔴 Critical | Editor shows post, nothing else | Label: "Used: Curiosity gap hook" with explanation |
| Analytics broken (manual xlsx upload) | 🔴 Critical | analytics.png — empty with instructions | Native pull OR skip analytics, do per-post performance |
| Zero lead capture | 🔴 Critical | Not in nav, not in settings, not anywhere | First-class nav section from day one |
| 8 different places for configuration | 🟠 High | Foundation + 7 Settings tabs | 3 tabs: My Voice / My Audience / Connections |
| Source vault split from Asset Library | 🟠 High | Two different screens for uploaded content | One unified vault, one entry point |
| Inspiration feed too dense | 🟠 High | Inspiration-feed-1.png — overwhelming | Filtered, breathable, connected to vault topics |
| No connection between vault and prompts | 🟠 High | Studio suggestions are generic | Prompts dynamically surface from your vault documents |
| Onboarding has 7 steps | 🟠 High | Steps 1-7 in progress bar | 4 steps max, show first post in step 3 |
| Website source config too technical | 🟡 Medium | Include/Exclude paths shown to everyone | Progressive disclosure — hide technical options |
| API source type shown to all users | 🟡 Medium | Source picker shows API card | Hide behind "Advanced" or "Developer" accordion |
| Posting schedule validation error | 🟡 Medium | 7 posts/week but 3 days selected | Real-time feedback, smart defaults |
| Drafts buried in a modal | 🟡 Medium | "Continue where you left off" overlay | Drafts as a visible section, not a popup |
| Content mix chart too early | 🟡 Medium | Schedule shows donut when only 1 post | Only show analytics with 5+ posts |
| Team upsell during onboarding | 🟡 Low | Step 3 team size picker | Move team features to post-activation |

---

## 5. ScoutHook UX Design Principles

These 7 principles guide every screen:

**Principle 1 — Document-first, not prompt-first**
The user's uploaded material is the hero. When they open the creation screen, they should see their vault documents, not a blank chat box. Every creation session starts with "which document?" not "what do you want to say?"

**Principle 2 — Value before configuration**
Show a generated post from a demo document before asking for setup details. The aha moment must come before the form. Steal the "Doing my homework" processing screen — ScoutHook's version processes the uploaded document and generates a sample post in real time.

**Principle 3 — One home for everything**
Document vault: one screen. Voice settings: one place (3 tabs max). Analytics: one dashboard. No duplication, no "also in Foundation."

**Principle 4 — Quality gate as a visible feature**
Postiv shows nothing between generation and delivery. ScoutHook shows "Your post passed 40 checks ✓" as a confidence signal before the user even sees the post. This is not just a backend feature — it's a product differentiator that must be on screen.

**Principle 5 — Hook transparency**
After every post is generated, label the hook type used ("Curiosity gap," "Bold claim," "Story hook," etc.) with a one-line explanation. This teaches the user and justifies the AI's choices.

**Principle 6 — Lead capture as a core section**
Not an afterthought. "Leads" appears in the primary navigation. Postiv's own users are asking for this (votes 5+6 on the feedback board). ScoutHook launches with it.

**Principle 7 — Simpler always wins**
When in doubt, remove a field. When in doubt, hide technical options. When in doubt, use plain English. Target users are consultants, coaches, and freelancers — not developers.

---

## 6. ScoutHook — Proposed Screen List

### Onboarding Wizard (4 steps, fullscreen, no sidebar)

| Step | Title | Key elements | Postiv comparison |
|---|---|---|---|
| Step 1 | Connect your LinkedIn | OAuth button, auto-detect name/profile | Same as A1 but single action |
| Step 2 | Upload your first document | Big drop zone: PDF, URL, YouTube, paste text | ScoutHook-only — this is our differentiator |
| Step 3 | Learning your voice... | Processing screen: "Scanning your document / Extracting your expertise / Building your voice profile / Drafting your first post" + live preview of generated post | Steal A4 format, make output visible |
| Step 4 | Here's your first post | Generated post from the document they just uploaded — aha moment | ScoutHook-only — no equivalent in Postiv |
| Step 5 | Activate your trial | $0 today, then pricing, trust badges | Same as A5 structure |

### Core App Screens

| Screen | Description | Priority |
|---|---|---|
| Dashboard | Activity stats: streak counter, next scheduled post, recent posts with engagement, vault document count, "Create from vault" hero CTA | P0 |
| Document Vault (home) | All uploaded docs: PDFs, URLs, YouTube, newsletters, with type filters and search | P0 |
| Add Document (picker) | Source type grid: PDF upload / Website URL / YouTube / Newsletter forwarding / Paste text | P0 |
| Create a Post (vault picker) | Choose which vault document to generate from — shows document title, upload date, last used | P0 |
| Post Generating (with quality gate) | "Scanning your vault / Selecting hook type / Drafting post / Running 40 checks" + quality badge | P0 |
| Post Editor | Split: post preview left, quality check panel right. Hook type label. Schedule / copy / iterate | P0 |
| Schedule Modal | Media attach + date/time + live preview. Shows already-scheduled posts. | P0 |
| Schedule Page | Week calendar + overview stats + upcoming posts list | P1 |
| My Voice (settings) | Writing style, CTAs, content principles, products — one page, 3 sub-tabs | P1 |
| My Audience (settings) | Target roles, industries, pain points, competitors | P1 |
| Connections (settings) | LinkedIn OAuth, billing, integrations | P1 |
| Lead Signals | Who commented on your posts, warm prospect list, reply suggestions | P1 |
| Inspiration Feed | Filtered by your topics, connected to vault documents | P2 |
| Analytics | Per-post performance: impressions, engagement, click-through, best day | P2 |
| Carousel Builder | From post → turn into branded carousel | P2 |
| Refer & Earn | Referral programme | P3 |

---

## 7. Key UX Patterns to Reuse from Postiv

### Patterns to copy exactly
- **Step progress bar** (numbered, labeled: Setup → Voice → Upload → Generate → Activate)
- **Time-aware greeting** in creation screen ("Good morning, [Name] / The best consultants post before breakfast")
- **"Searched your vault for X"** transparency during generation
- **Quick action chips** on inspiration posts ("Create similar / Key insights / Contrarian take")
- **"Saved ●"** indicator in post editor
- **Character count** in post editor (e.g., "1,190 / 3000")
- **Content type tags** on schedule cards (Text / Carousel / Image)
- **Live Desktop/Mobile preview toggle** in schedule modal
- **Calendar with existing scheduled posts highlighted** in schedule modal

### Patterns to improve
- **Source type picker grid** → Remove API card for non-technical users, rename "LinkedIn Profile" to "Your own LinkedIn posts"
- **Inspiration feed** → Add breathing room, filter by vault topic, show engagement as bars not numbers
- **Processing screen** → Make output visible at end (show generated post), not just a checklist
- **Schedule page** → Add "fill this slot" prompts for empty days in cadence

### Patterns to avoid
- Long scrolling settings pages (multiple sections stacked)
- Locked steps that block progress
- Generic starter prompts disconnected from user's content
- Modal-within-modal (carousel picker inside schedule modal — 3 layers deep)
- Separate pages for the same content (vault vs. asset library)

---

## 8. Reference: Postiv AI Product Positioning

From official documentation:
> "Postiv AI is your LinkedIn AI agent that transforms your existing knowledge into high-converting LinkedIn posts and carousels. Instead of creating generic content, it uses your expertise, past content, and unique voice to create authentic LinkedIn content that drives results."

Getting started steps (from Postiv's own onboarding email):
1. Upload your expertise (case studies, presentations, strategy docs, email sequences)
2. Add tone of voice instructions (via Settings → AI Context, NOT the content library)
3. Update AI profile (authority statements, CTAs, content principles)
4. Generate first posts using one of 5 prompt templates
5. Watch posts get published

**Pricing:** $99/month (Creator Pro, 1 seat). Team plans available. 7-day free trial.

---

## 9. How to Use This Document with Claude

**To design a specific screen, say:**
> "Using the project bible, design the ScoutHook [screen name] screen. Follow Principle [X] and steal the [pattern] from Postiv screen [reference]."

**To compare with Postiv, say:**
> "Referencing the project bible, how does Postiv handle [feature]? What should ScoutHook do differently?"

**To check a design decision, say:**
> "Does this design follow the ScoutHook UX principles in the project bible?"

**Example session opener:**
> "I'm attaching the ScoutHook project bible. We're designing the onboarding wizard. Start with Step 3 — the 'learning your voice' processing screen. It should be better than Postiv's Screen A4."

---

*Last updated: May 2026. 47 Postiv AI screens analysed. 8 flows documented. ScoutHook screen list: 16 screens across 3 priority tiers.*
