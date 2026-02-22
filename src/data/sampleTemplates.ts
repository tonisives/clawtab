import type { JobType } from "../types";
import webBrowsingImg from "./use-cases/web-browsing.png";
import codeDevImg from "./use-cases/code-dev.png";
import contentMarketingImg from "./use-cases/content-marketing.png";
import dataResearchImg from "./use-cases/data-research.png";
import devopsImg from "./use-cases/devops.png";
import financeImg from "./use-cases/finance.png";
import productivityImg from "./use-cases/productivity.png";

export interface TemplateVariable {
  key: string;
  label: string;
  placeholder: string;
}

export interface SampleTemplate {
  id: string;
  name: string;
  category: string;
  categoryIcon: string;
  description: string;
  job_type: JobType;
  cron: string;
  group: string;
  template: string;
  variables?: TemplateVariable[];
}

export const TEMPLATE_CATEGORIES = [
  { id: "web-browsing", name: "Web Browsing & Social Media", icon: "globe", image: webBrowsingImg },
  { id: "code-dev", name: "Code & Development", icon: "code", image: codeDevImg },
  { id: "content-marketing", name: "Content & Marketing", icon: "pen", image: contentMarketingImg },
  { id: "data-research", name: "Data & Research", icon: "chart", image: dataResearchImg },
  { id: "devops", name: "DevOps & Monitoring", icon: "server", image: devopsImg },
  { id: "finance", name: "Finance & Crypto", icon: "dollar", image: financeImg },
  { id: "productivity", name: "Personal Productivity", icon: "clock", image: productivityImg },
] as const;

export const SAMPLE_TEMPLATES: SampleTemplate[] = [
  // --- Web Browsing & Social Media ---
  {
    id: "twitter-engagement",
    name: "X/Twitter Engagement Agent",
    category: "web-browsing",
    categoryIcon: "globe",
    description: "Monitor posts matching a topic, draft reply suggestions, send digest to Telegram",
    job_type: "folder",
    cron: "0 9 * * *",
    group: "social",
    template: `# X/Twitter Engagement Agent

## Goal
Monitor X/Twitter for posts about [YOUR_TOPIC] and compile an engagement digest.

## Steps
1. Open Safari and navigate to x.com/search
2. Search for posts about [YOUR_TOPIC] from the last 24 hours
3. For each relevant post:
   - Note the author, content, and engagement metrics
   - Draft a short, authentic reply suggestion
4. Compile results into a summary
5. Send the digest to Telegram with top 5 posts and suggested replies

## Output Format
For each post:
- Author: @handle
- Content: (first 280 chars)
- Engagement: likes/retweets/replies
- Suggested reply: (your draft)
`,
    variables: [
      { key: "YOUR_TOPIC", label: "Topic or keyword to monitor", placeholder: "e.g. AI agents, Rust lang, indie hacking" },
    ],
  },
  {
    id: "reddit-research",
    name: "Reddit Research Agent",
    category: "web-browsing",
    categoryIcon: "globe",
    description: "Browse subreddits, summarize top discussions and sentiment",
    job_type: "folder",
    cron: "0 8 * * 1",
    group: "social",
    template: `# Reddit Research Agent

## Goal
Research r/[YOUR_SUBREDDIT] for trending discussions and summarize key insights.

## Steps
1. Open Safari and navigate to reddit.com/r/[YOUR_SUBREDDIT]
2. Sort by "Hot" and scan the top 20 posts
3. For interesting threads, read top comments
4. Identify recurring themes, complaints, and feature requests
5. Compile a weekly briefing

## Output Format
- Top themes this week (3-5 bullet points)
- Notable posts with summaries
- Community sentiment overview
- Action items or opportunities spotted
`,
    variables: [
      { key: "YOUR_SUBREDDIT", label: "Subreddit name (without r/)", placeholder: "e.g. programming, startups, macapps" },
    ],
  },
  {
    id: "competitor-monitor",
    name: "Competitor Website Monitor",
    category: "web-browsing",
    categoryIcon: "globe",
    description: "Track changes on competitor websites, report new features or content",
    job_type: "folder",
    cron: "0 7 * * 1,4",
    group: "research",
    template: `# Competitor Website Monitor

## Goal
Check [YOUR_WEBSITE] for changes since last run and report findings.

## Steps
1. Open Safari and navigate to [YOUR_WEBSITE]
2. Check the following pages:
   - Homepage (hero text, pricing, CTAs)
   - Pricing page (plan changes, new tiers)
   - Blog/changelog (new posts, feature announcements)
   - Product pages (new features, UI changes)
3. Compare with previous observations (check .cwt/notes/ if available)
4. Document any changes found

## Output Format
- Changes detected: (list each change with before/after if possible)
- New content: (blog posts, changelog entries)
- Assessment: (significance of changes, competitive implications)
`,
    variables: [
      { key: "YOUR_WEBSITE", label: "Competitor website URL", placeholder: "e.g. https://competitor.com" },
    ],
  },
  {
    id: "linkedin-engagement",
    name: "LinkedIn Engagement",
    category: "web-browsing",
    categoryIcon: "globe",
    description: "Find and engage with relevant LinkedIn posts in your industry",
    job_type: "folder",
    cron: "0 10 * * 1,3,5",
    group: "social",
    template: `# LinkedIn Engagement Agent

## Goal
Find relevant LinkedIn posts about [YOUR_TOPIC] and draft thoughtful comments.

## Steps
1. Open Safari and navigate to linkedin.com/feed
2. Search for posts about [YOUR_TOPIC]
3. Identify 5 high-quality posts from thought leaders
4. Draft genuine, insightful comments for each (not generic praise)
5. Compile the list for review before posting

## Output Format
For each post:
- Author and headline
- Post summary
- Draft comment (2-3 sentences, add value to the discussion)
- Link to post
`,
    variables: [
      { key: "YOUR_TOPIC", label: "Industry topic or keyword", placeholder: "e.g. developer tools, remote work, AI" },
    ],
  },
  {
    id: "news-digest",
    name: "News Digest",
    category: "web-browsing",
    categoryIcon: "globe",
    description: "Browse news sites and compile a daily summary of relevant stories",
    job_type: "folder",
    cron: "0 7 * * *",
    group: "research",
    template: `# Daily News Digest

## Goal
Compile a morning briefing of [YOUR_TOPIC] news from multiple sources.

## Steps
1. Open Safari and check these sources:
   - Hacker News (news.ycombinator.com) - top stories
   - TechCrunch / Ars Technica - headlines
   - Relevant industry blogs
2. Filter for stories related to [YOUR_TOPIC]
3. For each relevant story: title, source, 2-sentence summary
4. Rank by relevance and importance
5. Send digest to Telegram

## Output Format
Morning Briefing - [date]
1. [Headline] (source) - summary
2. ...
Top story deep-dive: (3-4 sentences on the most important story)
`,
    variables: [
      { key: "YOUR_TOPIC", label: "News topic to track", placeholder: "e.g. AI/ML, cybersecurity, macOS" },
    ],
  },
  {
    id: "producthunt-monitor",
    name: "Product Hunt Monitor",
    category: "web-browsing",
    categoryIcon: "globe",
    description: "Track new Product Hunt launches, report interesting products",
    job_type: "folder",
    cron: "0 18 * * *",
    group: "research",
    template: `# Product Hunt Monitor

## Goal
Review today's Product Hunt launches and identify interesting products.

## Steps
1. Open Safari and navigate to producthunt.com
2. Review today's top 10 launched products
3. For each product note: name, tagline, category, upvote count
4. Identify products relevant to [YOUR_INTEREST]
5. Provide brief analysis of trends

## Output Format
- Date and total launches reviewed
- Top 5 products (name, tagline, votes, your assessment)
- Products relevant to [YOUR_INTEREST]
- Trend observations (patterns in launches today)
`,
    variables: [
      { key: "YOUR_INTEREST", label: "Your area of interest", placeholder: "e.g. developer tools, productivity, AI" },
    ],
  },

  // --- Code & Development ---
  {
    id: "pr-review",
    name: "PR Review Agent",
    category: "code-dev",
    categoryIcon: "code",
    description: "Review open pull requests, suggest improvements and catch issues",
    job_type: "folder",
    cron: "0 9 * * 1,2,3,4,5",
    group: "dev",
    template: `# PR Review Agent

## Goal
Review open pull requests and provide constructive feedback.

## Steps
1. Run \`gh pr list --state open\` to find open PRs
2. For each PR:
   - Read the diff with \`gh pr diff <number>\`
   - Check for: bugs, security issues, style inconsistencies, missing tests
   - Note positive aspects too
3. Draft review comments
4. Summarize findings

## Output Format
For each PR:
- PR #number: title
- Risk level: low/medium/high
- Issues found: (list)
- Suggestions: (list)
- Overall assessment
`,
  },
  {
    id: "test-writer",
    name: "Test Writer",
    category: "code-dev",
    categoryIcon: "code",
    description: "Generate tests for uncovered code paths",
    job_type: "folder",
    cron: "0 14 * * 5",
    group: "dev",
    template: `# Test Writer Agent

## Goal
Find untested code paths and generate meaningful test cases.

## Steps
1. Check test coverage if a coverage tool is configured
2. Identify files with low or no test coverage
3. Read the source code of uncovered files
4. Generate test cases that cover:
   - Happy paths
   - Edge cases
   - Error conditions
5. Write tests following the project's existing test patterns

## Output Format
- Files analyzed: (list)
- Tests generated: (count)
- Coverage improvement estimate
- Any code that's hard to test (and why)
`,
  },
  {
    id: "dependency-auditor",
    name: "Dependency Auditor",
    category: "code-dev",
    categoryIcon: "code",
    description: "Check for outdated packages and security advisories",
    job_type: "folder",
    cron: "0 6 * * 1",
    group: "dev",
    template: `# Dependency Auditor

## Goal
Audit project dependencies for updates and security issues.

## Steps
1. Check for outdated packages:
   - Node.js: \`npm outdated\` or \`pnpm outdated\`
   - Rust: \`cargo outdated\` (if installed)
   - Python: \`pip list --outdated\`
2. Check for security vulnerabilities:
   - \`npm audit\` / \`pnpm audit\`
   - \`cargo audit\` (if installed)
3. Categorize updates by severity (patch/minor/major)
4. Note any breaking changes in major updates

## Output Format
- Critical security issues: (list with CVE numbers)
- Outdated packages: (grouped by severity)
- Recommended update order
- Breaking change warnings
`,
  },
  {
    id: "code-refactor",
    name: "Code Refactoring Agent",
    category: "code-dev",
    categoryIcon: "code",
    description: "Find code smells and propose targeted improvements",
    job_type: "folder",
    cron: "0 10 * * 5",
    group: "dev",
    template: `# Code Refactoring Agent

## Goal
Identify code smells and propose focused refactoring improvements.

## Steps
1. Scan the codebase for common issues:
   - Functions longer than 50 lines
   - Deeply nested conditionals (>3 levels)
   - Duplicated code blocks
   - Unused imports or variables
   - TODO/FIXME comments older than 30 days
2. For each issue, propose a specific fix
3. Prioritize by impact and effort

## Output Format
- Issues found: (count by category)
- Top 5 refactoring opportunities:
  - File and location
  - Current problem
  - Proposed fix
  - Estimated effort (small/medium/large)
`,
  },
  {
    id: "docs-updater",
    name: "Documentation Updater",
    category: "code-dev",
    categoryIcon: "code",
    description: "Scan recent changes and update docs/READMEs accordingly",
    job_type: "folder",
    cron: "0 16 * * 5",
    group: "dev",
    template: `# Documentation Updater

## Goal
Keep documentation in sync with recent code changes.

## Steps
1. Check recent commits: \`git log --oneline -20\`
2. Identify changes that affect documented behavior:
   - New features or commands
   - Changed APIs or configurations
   - Removed functionality
3. Read current README.md and docs/
4. Update documentation to reflect changes
5. Check for broken links or outdated examples

## Output Format
- Commits reviewed: (count)
- Docs updated: (list of files)
- Changes made: (summary of each update)
- Issues found: (broken links, outdated info)
`,
  },

  // --- Content & Marketing ---
  {
    id: "blog-drafter",
    name: "Blog Post Drafter",
    category: "content-marketing",
    categoryIcon: "pen",
    description: "Research a topic and draft a blog post outline with key points",
    job_type: "folder",
    cron: "0 9 * * 1",
    group: "content",
    template: `# Blog Post Drafter

## Goal
Research and draft a blog post about [YOUR_TOPIC].

## Steps
1. Research [YOUR_TOPIC] using web browsing:
   - Find recent articles and discussions
   - Identify unique angles not covered elsewhere
   - Gather data points and examples
2. Create an outline with:
   - Compelling headline options (3 alternatives)
   - Introduction hook
   - 3-5 main sections with key points
   - Conclusion with call to action
3. Draft the full post (800-1200 words)

## Output Format
- Headline: (top choice + alternatives)
- Outline: (section headers and bullet points)
- Draft: (full text)
- Sources: (links to research)
`,
    variables: [
      { key: "YOUR_TOPIC", label: "Blog post topic", placeholder: "e.g. Why we switched to Rust, Building AI agents" },
    ],
  },
  {
    id: "social-planner",
    name: "Social Media Content Planner",
    category: "content-marketing",
    categoryIcon: "pen",
    description: "Generate a week of social media content ideas with drafts",
    job_type: "folder",
    cron: "0 9 * * 0",
    group: "content",
    template: `# Social Media Content Planner

## Goal
Plan a week of social media content for [YOUR_BRAND].

## Steps
1. Review what performed well recently (check notes from past runs)
2. Research trending topics in the industry
3. Generate 7 post ideas (one per day):
   - Mix of formats: tips, insights, questions, stories, announcements
   - Each with platform-specific variations (Twitter/LinkedIn)
4. Draft copy for each post

## Output Format
For each day (Mon-Sun):
- Theme: (topic)
- Twitter draft: (280 chars max)
- LinkedIn draft: (longer format)
- Best posting time
- Hashtags: (3-5 relevant)
`,
    variables: [
      { key: "YOUR_BRAND", label: "Brand or product name", placeholder: "e.g. MyApp, our engineering blog" },
    ],
  },
  {
    id: "seo-analyzer",
    name: "SEO Analyzer",
    category: "content-marketing",
    categoryIcon: "pen",
    description: "Audit pages for search ranking improvements",
    job_type: "folder",
    cron: "0 6 * * 1",
    group: "content",
    template: `# SEO Analyzer

## Goal
Audit [YOUR_WEBSITE] for SEO improvements.

## Steps
1. Open Safari and navigate to [YOUR_WEBSITE]
2. Check each page for:
   - Title tag (length, keyword inclusion)
   - Meta description (length, compelling copy)
   - H1/H2 structure (hierarchy, keywords)
   - Image alt text
   - Internal linking
   - Page load indicators
3. Check robots.txt and sitemap.xml
4. Compare with top competitor pages

## Output Format
- Pages audited: (count)
- Critical issues: (missing titles, broken links)
- Quick wins: (easy improvements)
- Strategic recommendations: (content gaps, keyword opportunities)
`,
    variables: [
      { key: "YOUR_WEBSITE", label: "Website URL to audit", placeholder: "e.g. https://mysite.com" },
    ],
  },
  {
    id: "changelog-generator",
    name: "Changelog Generator",
    category: "content-marketing",
    categoryIcon: "pen",
    description: "Compile release notes from recent commits and PRs",
    job_type: "folder",
    cron: "0 17 * * 5",
    group: "dev",
    template: `# Changelog Generator

## Goal
Generate a changelog from recent git activity.

## Steps
1. Get commits since last tag: \`git log $(git describe --tags --abbrev=0)..HEAD --oneline\`
2. Get merged PRs: \`gh pr list --state merged --limit 20\`
3. Categorize changes:
   - Features (new functionality)
   - Fixes (bug fixes)
   - Improvements (enhancements)
   - Breaking changes
4. Write human-readable changelog entries
5. Save to CHANGELOG.md

## Output Format
## [version] - [date]
### Added
- Feature description (#PR)
### Fixed
- Bug fix description (#PR)
### Changed
- Improvement description (#PR)
`,
  },

  // --- Data & Research ---
  {
    id: "market-research",
    name: "Market Research Agent",
    category: "data-research",
    categoryIcon: "chart",
    description: "Browse industry sites and compile competitive intelligence",
    job_type: "folder",
    cron: "0 8 * * 1",
    group: "research",
    template: `# Market Research Agent

## Goal
Compile weekly intelligence on [YOUR_MARKET].

## Steps
1. Browse key industry sources:
   - Industry news sites and blogs
   - Competitor announcements
   - Market analysis reports
2. Track:
   - New entrants and products
   - Funding rounds and acquisitions
   - Technology trends
   - Customer sentiment shifts
3. Synthesize findings into an actionable briefing

## Output Format
- Market pulse: (3-sentence overview)
- Key events this week: (bulleted list)
- Competitor moves: (who did what)
- Opportunities identified: (actionable items)
- Threats to watch: (risks)
`,
    variables: [
      { key: "YOUR_MARKET", label: "Market or industry", placeholder: "e.g. developer tools, SaaS, fintech" },
    ],
  },
  {
    id: "price-tracker",
    name: "Price Tracker",
    category: "data-research",
    categoryIcon: "chart",
    description: "Monitor product prices across sites, alert on changes",
    job_type: "folder",
    cron: "0 6 * * *",
    group: "research",
    template: `# Price Tracker

## Goal
Monitor prices for [YOUR_PRODUCT] and alert on significant changes.

## Steps
1. Open Safari and check pricing on these sources:
   - Primary retailer / official site
   - Amazon or relevant marketplace
   - Alternative sellers
2. Record current prices
3. Compare with previous run's prices (check .cwt/notes/)
4. Alert if price dropped more than 5% or increased significantly

## Output Format
- Product: [YOUR_PRODUCT]
- Current prices: (source: price)
- Previous prices: (if available)
- Change: +/-percentage
- Recommendation: buy/wait/alert
`,
    variables: [
      { key: "YOUR_PRODUCT", label: "Product to track", placeholder: "e.g. MacBook Pro M4, specific GPU model" },
    ],
  },
  {
    id: "paper-digest",
    name: "Academic Paper Digest",
    category: "data-research",
    categoryIcon: "chart",
    description: "Search for recent papers on a topic and create summaries",
    job_type: "folder",
    cron: "0 8 * * 1",
    group: "research",
    template: `# Academic Paper Digest

## Goal
Find and summarize recent research papers about [YOUR_TOPIC].

## Steps
1. Open Safari and search on:
   - arxiv.org (cs/AI sections)
   - Google Scholar
   - Semantic Scholar
2. Filter for papers from the last month
3. Select top 5 most relevant papers
4. For each paper: read abstract and introduction, summarize key contributions

## Output Format
Weekly Paper Digest - [YOUR_TOPIC]
For each paper:
- Title and authors
- Published: (date)
- Key contribution: (2-3 sentences)
- Relevance: (why this matters)
- Link
`,
    variables: [
      { key: "YOUR_TOPIC", label: "Research topic", placeholder: "e.g. LLM reasoning, code generation, robotics" },
    ],
  },
  {
    id: "job-market-scanner",
    name: "Job Market Scanner",
    category: "data-research",
    categoryIcon: "chart",
    description: "Track job postings in a field and summarize hiring trends",
    job_type: "folder",
    cron: "0 7 * * 1",
    group: "research",
    template: `# Job Market Scanner

## Goal
Analyze job postings for [YOUR_FIELD] and identify trends.

## Steps
1. Open Safari and check:
   - LinkedIn Jobs for [YOUR_FIELD]
   - Hacker News "Who is Hiring" threads
   - Relevant job boards
2. Track:
   - Number of postings (up/down trend)
   - Common tech stack requirements
   - Salary ranges mentioned
   - Remote vs. on-site ratios
   - New skills appearing in requirements
3. Compile trend report

## Output Format
- Postings reviewed: (count)
- Top skills demanded: (ranked list)
- Salary range: (low/median/high)
- Remote ratio: (percentage)
- Emerging trends: (new requirements appearing)
`,
    variables: [
      { key: "YOUR_FIELD", label: "Job field or role", placeholder: "e.g. Rust developer, ML engineer, DevOps" },
    ],
  },

  // --- DevOps & Monitoring ---
  {
    id: "server-health",
    name: "Server Health Check",
    category: "devops",
    categoryIcon: "server",
    description: "Run diagnostics on servers, report status and anomalies",
    job_type: "folder",
    cron: "0 */4 * * *",
    group: "ops",
    template: `# Server Health Check

## Goal
Run health diagnostics and report any issues.

## Steps
1. Check system resources:
   - CPU usage: \`top -l 1 | head -10\`
   - Memory: \`vm_stat\` or \`free -h\`
   - Disk: \`df -h\`
2. Check running services:
   - Docker containers: \`docker ps\`
   - Key processes: verify expected services are running
3. Check connectivity:
   - DNS resolution
   - Key endpoint health checks
4. Report any anomalies

## Output Format
- Status: OK / WARNING / CRITICAL
- CPU: usage%
- Memory: used/total
- Disk: used/total per mount
- Services: all up / issues (list)
- Alerts: (any anomalies detected)
`,
  },
  {
    id: "backup-verifier",
    name: "Backup Verifier",
    category: "devops",
    categoryIcon: "server",
    description: "Verify backups exist, are recent, and have correct checksums",
    job_type: "folder",
    cron: "0 5 * * *",
    group: "ops",
    template: `# Backup Verifier

## Goal
Verify that backups are current and valid.

## Steps
1. Check backup locations:
   - Local backup directory
   - Remote backup storage (if configured)
2. For each backup:
   - Verify file exists
   - Check last modified date (should be within 24h)
   - Verify file size is reasonable (not 0 bytes)
   - Check checksum if available
3. Report any missing or stale backups

## Output Format
- Backups checked: (count)
- All OK: yes/no
- Issues:
  - Missing: (list)
  - Stale (>24h old): (list)
  - Size anomalies: (list)
- Last successful backup: (timestamp)
`,
  },
  {
    id: "ssl-monitor",
    name: "SSL Certificate Monitor",
    category: "devops",
    categoryIcon: "server",
    description: "Check SSL certificate expiry dates and alert if expiring soon",
    job_type: "folder",
    cron: "0 6 * * 1",
    group: "ops",
    template: `# SSL Certificate Monitor

## Goal
Check SSL certificates for [YOUR_DOMAINS] and alert if expiring within 30 days.

## Steps
1. For each domain, check certificate:
   \`echo | openssl s_client -servername DOMAIN -connect DOMAIN:443 2>/dev/null | openssl x509 -noout -dates\`
2. Parse expiry dates
3. Calculate days until expiry
4. Flag any certificates expiring within 30 days

## Domains to Check
[YOUR_DOMAINS]

## Output Format
For each domain:
- Domain: name
- Expires: date
- Days remaining: N
- Status: OK / WARNING (<30 days) / CRITICAL (<7 days)
`,
    variables: [
      { key: "YOUR_DOMAINS", label: "Domains to check (one per line)", placeholder: "e.g. example.com\napi.example.com" },
    ],
  },
  {
    id: "log-analyzer",
    name: "Log Analyzer",
    category: "devops",
    categoryIcon: "server",
    description: "Parse application logs, identify errors and anomalies",
    job_type: "folder",
    cron: "0 8 * * *",
    group: "ops",
    template: `# Log Analyzer

## Goal
Analyze recent application logs for errors and patterns.

## Steps
1. Read recent log files (last 24 hours)
2. Categorize log entries:
   - Errors and exceptions (with stack traces)
   - Warnings
   - Slow operations (>1s response times)
   - Unusual patterns (spike in specific error types)
3. Group similar errors together
4. Identify new errors not seen before

## Output Format
- Period: last 24 hours
- Total errors: (count)
- Unique error types: (count)
- Top 5 errors: (type, count, sample message)
- New errors: (not seen in previous runs)
- Performance outliers: (slow operations)
`,
  },

  // --- Finance & Crypto ---
  {
    id: "defi-yield",
    name: "DeFi Yield Monitor",
    category: "finance",
    categoryIcon: "dollar",
    description: "Check DeFi yield rates across protocols, report via Telegram",
    job_type: "folder",
    cron: "0 8 * * *",
    group: "finance",
    template: `# DeFi Yield Monitor

## Goal
Check current DeFi yield rates and report significant changes.

## Steps
1. Open Safari and check yield rates on:
   - DeFiLlama yields page
   - Major protocols (Aave, Compound, Lido, etc.)
2. Record current rates for [YOUR_ASSETS]
3. Compare with previous run's rates
4. Flag any significant changes (>0.5% APY shift)

## Assets to Track
[YOUR_ASSETS]

## Output Format
- Date: [date]
- For each asset:
  - Protocol: name
  - Current APY: X%
  - Previous APY: Y%
  - Change: +/- Z%
- Best opportunities: (top 3 by APY)
- Alerts: (significant changes)
`,
    variables: [
      { key: "YOUR_ASSETS", label: "Assets/pools to track", placeholder: "e.g. ETH staking, USDC lending, stETH/ETH LP" },
    ],
  },
  {
    id: "portfolio-tracker",
    name: "Portfolio Tracker",
    category: "finance",
    categoryIcon: "dollar",
    description: "Aggregate portfolio positions and generate daily P&L summary",
    job_type: "folder",
    cron: "0 20 * * *",
    group: "finance",
    template: `# Portfolio Tracker

## Goal
Generate a daily summary of portfolio performance.

## Steps
1. Check current prices for tracked assets
2. Calculate position values
3. Compare with yesterday's values
4. Generate P&L summary

## Portfolio
Track the following positions:
- List your holdings and quantities here

## Output Format
- Portfolio value: $X
- Daily change: +/- $Y (Z%)
- Top gainers: (asset, % change)
- Top losers: (asset, % change)
- Allocation breakdown: (asset: % of portfolio)
`,
  },
  {
    id: "stablecoin-rates",
    name: "Stablecoin Rate Checker",
    category: "finance",
    categoryIcon: "dollar",
    description: "Monitor stablecoin rates and peg stability across exchanges",
    job_type: "folder",
    cron: "0 */6 * * *",
    group: "finance",
    template: `# Stablecoin Rate Checker

## Goal
Monitor stablecoin peg stability and lending rates.

## Steps
1. Check peg prices for major stablecoins:
   - USDT, USDC, DAI, FRAX
2. Check lending rates across platforms
3. Flag any depegging events (>0.5% deviation)
4. Note arbitrage opportunities

## Output Format
- Stablecoin prices:
  - USDT: $X.XXXX
  - USDC: $X.XXXX
  - DAI: $X.XXXX
- Lending rates: (protocol: rate for each)
- Peg status: all stable / WARNING (list deviations)
- Arbitrage opportunities: (if any)
`,
  },
  {
    id: "airdrop-tracker",
    name: "Airdrop Tracker",
    category: "finance",
    categoryIcon: "dollar",
    description: "Track upcoming airdrops and check eligibility criteria",
    job_type: "folder",
    cron: "0 9 * * 1,4",
    group: "finance",
    template: `# Airdrop Tracker

## Goal
Track upcoming crypto airdrops and eligibility requirements.

## Steps
1. Open Safari and check airdrop aggregator sites
2. Filter for upcoming airdrops with confirmed or rumored dates
3. Check eligibility criteria for each
4. Note required actions (bridging, swaps, governance participation)
5. Compile actionable list

## Output Format
- Active/upcoming airdrops: (count)
- For each:
  - Project name
  - Estimated date
  - Eligibility criteria
  - Required actions
  - Potential value estimate (if available)
- Priority actions: (what to do this week)
`,
  },

  // --- Personal Productivity ---
  {
    id: "email-drafter",
    name: "Email Drafter",
    category: "productivity",
    categoryIcon: "clock",
    description: "Review flagged emails and draft professional responses",
    job_type: "folder",
    cron: "0 8 * * 1,2,3,4,5",
    group: "personal",
    template: `# Email Drafter

## Goal
Draft responses for emails that need attention.

## Context
This agent reads email subjects/summaries you've saved to .cwt/inbox/ and drafts replies.
Save emails you need help with as text files in the inbox folder.

## Steps
1. Check .cwt/inbox/ for new email files
2. For each email:
   - Understand the context and what's being asked
   - Draft a professional response
   - Match the tone (formal/casual based on sender)
3. Save drafts to .cwt/drafts/

## Output Format
For each email:
- From: (sender)
- Subject: (subject line)
- Draft response: (your suggested reply)
- Tone: formal/casual
- Action items: (things you mentioned you'd do)
`,
  },
  {
    id: "weekly-review",
    name: "Weekly Review Generator",
    category: "productivity",
    categoryIcon: "clock",
    description: "Summarize the week's work from git commits and task activity",
    job_type: "folder",
    cron: "0 17 * * 5",
    group: "personal",
    template: `# Weekly Review Generator

## Goal
Generate a comprehensive weekly review of accomplishments.

## Steps
1. Check git activity: \`git log --oneline --since="7 days ago" --all\`
2. Count commits, files changed, insertions/deletions
3. Identify key themes and accomplishments
4. Note any ongoing work or blockers
5. Generate next week's priorities based on patterns

## Output Format
# Week of [date range]

## Accomplishments
- (key things completed)

## By the Numbers
- Commits: N
- Files changed: N
- Lines added/removed: +N/-N

## In Progress
- (ongoing work)

## Next Week Priorities
- (suggested focus areas)
`,
  },
  {
    id: "learning-agent",
    name: "Learning Agent",
    category: "productivity",
    categoryIcon: "clock",
    description: "Research a topic and compile structured study notes",
    job_type: "folder",
    cron: "0 10 * * 6",
    group: "personal",
    template: `# Learning Agent

## Goal
Research [YOUR_TOPIC] and compile structured learning notes.

## Steps
1. Open Safari and research [YOUR_TOPIC]:
   - Official documentation
   - Tutorial sites and guides
   - Community discussions (Stack Overflow, Reddit)
2. Organize information into:
   - Core concepts (what you need to know first)
   - Key techniques (how to apply the knowledge)
   - Common pitfalls (mistakes to avoid)
   - Resources (links for deeper learning)
3. Create a study summary

## Output Format
# Learning Notes: [YOUR_TOPIC]

## Core Concepts
- (fundamental ideas, explained simply)

## Key Techniques
- (practical how-to information)

## Common Pitfalls
- (mistakes others make and how to avoid them)

## Resources
- (links to the best tutorials, docs, and guides)
`,
    variables: [
      { key: "YOUR_TOPIC", label: "Topic to learn about", placeholder: "e.g. Kubernetes networking, WebAssembly, Nix" },
    ],
  },
];
