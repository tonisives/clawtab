export type Template = {
  id: string
  title: string
  desc: string
  cron: string
  code: string
}

export type UseCase = {
  title: string
  desc: string
  image: string
  templates: Template[]
}

export let useCases: UseCase[][] = [
  [
    {
      title: "Web Browsing & Social Media",
      desc: "Safari-based agents that browse sites, track changes, and engage with content.",
      image: "/assets/use-cases/web-browsing.png",
      templates: [
        {
          id: "twitter-engagement",
          title: "X/Twitter Engagement Agent",
          desc: "Monitor posts, draft replies, send digest to Telegram",
          cron: "0 9 * * *",
          code: `# X/Twitter Engagement Agent\n## Steps\n1. Open Safari and navigate to x.com/search\n2. Search for posts about [YOUR_TOPIC]\n3. Draft short, authentic reply suggestions\n4. Send digest to Telegram with top 5 posts`,
        },
        {
          id: "reddit-research",
          title: "Reddit Research Agent",
          desc: "Browse subreddits, summarize discussions and sentiment",
          cron: "0 8 * * 1",
          code: `# Reddit Research Agent\n## Steps\n1. Open Safari and navigate to reddit.com/r/[YOUR_SUBREDDIT]\n2. Sort by "Hot" and scan the top 20 posts\n3. Read top comments on interesting threads\n4. Compile weekly briefing with themes and sentiment`,
        },
        {
          id: "competitor-monitor",
          title: "Competitor Website Monitor",
          desc: "Track changes on competitor sites, report new features",
          cron: "0 7 * * 1,4",
          code: `# Competitor Website Monitor\n## Steps\n1. Open Safari and navigate to [YOUR_WEBSITE]\n2. Check homepage, pricing, blog, product pages\n3. Compare with previous observations\n4. Document changes and competitive implications`,
        },
        {
          id: "linkedin-engagement",
          title: "LinkedIn Engagement",
          desc: "Find relevant posts, draft thoughtful comments",
          cron: "0 10 * * 1,3,5",
          code: `# LinkedIn Engagement Agent\n## Steps\n1. Open Safari and navigate to linkedin.com/feed\n2. Search for posts about [YOUR_TOPIC]\n3. Identify 5 high-quality posts from thought leaders\n4. Draft genuine, insightful comments for each`,
        },
        {
          id: "news-digest",
          title: "News Digest",
          desc: "Browse news sites, compile daily summary",
          cron: "0 7 * * *",
          code: `# Daily News Digest\n## Steps\n1. Check Hacker News, TechCrunch, Ars Technica\n2. Filter for stories related to [YOUR_TOPIC]\n3. Summarize each: title, source, 2-sentence summary\n4. Send morning briefing to Telegram`,
        },
        {
          id: "producthunt-monitor",
          title: "Product Hunt Monitor",
          desc: "Track new launches, report interesting products",
          cron: "0 18 * * *",
          code: `# Product Hunt Monitor\n## Steps\n1. Open Safari and navigate to producthunt.com\n2. Review today's top 10 launched products\n3. Note name, tagline, category, upvote count\n4. Identify products relevant to your interests`,
        },
      ],
    },
    {
      title: "Code & Development",
      desc: "Claude Code agents for PR reviews, testing, refactoring, and documentation.",
      image: "/assets/use-cases/code-dev.png",
      templates: [
        {
          id: "pr-review",
          title: "PR Review Agent",
          desc: "Review open PRs, suggest improvements and catch issues",
          cron: "0 9 * * 1-5",
          code: `# PR Review Agent\n## Steps\n1. Run \`gh pr list --state open\`\n2. Read each diff with \`gh pr diff\`\n3. Check for bugs, security issues, missing tests\n4. Draft review comments and summarize`,
        },
        {
          id: "test-writer",
          title: "Test Writer",
          desc: "Generate tests for uncovered code paths",
          cron: "0 14 * * 5",
          code: `# Test Writer Agent\n## Steps\n1. Check test coverage if configured\n2. Identify files with low or no coverage\n3. Generate tests: happy paths, edge cases, errors\n4. Follow project's existing test patterns`,
        },
        {
          id: "dependency-auditor",
          title: "Dependency Auditor",
          desc: "Check outdated packages, security advisories",
          cron: "0 6 * * 1",
          code: `# Dependency Auditor\n## Steps\n1. Run \`npm outdated\` / \`cargo outdated\`\n2. Run \`npm audit\` / \`cargo audit\`\n3. Categorize updates by severity\n4. Note breaking changes in major updates`,
        },
        {
          id: "code-refactor",
          title: "Code Refactoring Agent",
          desc: "Find code smells, propose improvements",
          cron: "0 10 * * 5",
          code: `# Code Refactoring Agent\n## Steps\n1. Scan for functions >50 lines, deep nesting\n2. Find duplicated code blocks, unused imports\n3. Check for stale TODO/FIXME comments\n4. Propose fixes prioritized by impact`,
        },
        {
          id: "docs-updater",
          title: "Documentation Updater",
          desc: "Scan changes, update docs and READMEs",
          cron: "0 16 * * 5",
          code: `# Documentation Updater\n## Steps\n1. Check recent commits: \`git log --oneline -20\`\n2. Identify changes affecting documented behavior\n3. Update README.md and docs/ accordingly\n4. Check for broken links or outdated examples`,
        },
      ],
    },
  ],
  [
    {
      title: "Content & Marketing",
      desc: "Automate blog drafts, social planning, SEO audits, and changelogs.",
      image: "/assets/use-cases/content-marketing.png",
      templates: [
        {
          id: "blog-drafter",
          title: "Blog Post Drafter",
          desc: "Research and draft blog posts with outlines",
          cron: "0 9 * * 1",
          code: `# Blog Post Drafter\n## Steps\n1. Research [YOUR_TOPIC] via web browsing\n2. Find unique angles not covered elsewhere\n3. Create outline with 3 headline options\n4. Draft full post (800-1200 words)`,
        },
        {
          id: "social-planner",
          title: "Social Media Content Planner",
          desc: "Generate a week of content ideas with drafts",
          cron: "0 9 * * 0",
          code: `# Social Media Content Planner\n## Steps\n1. Review what performed well recently\n2. Research trending industry topics\n3. Generate 7 post ideas (one per day)\n4. Draft copy for Twitter and LinkedIn`,
        },
        {
          id: "seo-analyzer",
          title: "SEO Analyzer",
          desc: "Audit pages, suggest search ranking improvements",
          cron: "0 6 * * 1",
          code: `# SEO Analyzer\n## Steps\n1. Open Safari and navigate to [YOUR_WEBSITE]\n2. Check title tags, meta descriptions, headings\n3. Audit image alt text and internal linking\n4. Compare with top competitor pages`,
        },
        {
          id: "changelog-generator",
          title: "Changelog Generator",
          desc: "Compile release notes from recent commits",
          cron: "0 17 * * 5",
          code: `# Changelog Generator\n## Steps\n1. Get commits since last tag\n2. Get merged PRs: \`gh pr list --state merged\`\n3. Categorize: features, fixes, improvements\n4. Write human-readable changelog entries`,
        },
      ],
    },
    {
      title: "Data & Research",
      desc: "Market intelligence, price tracking, paper digests, and trend analysis.",
      image: "/assets/use-cases/data-research.png",
      templates: [
        {
          id: "market-research",
          title: "Market Research Agent",
          desc: "Browse industry sites, compile competitive intelligence",
          cron: "0 8 * * 1",
          code: `# Market Research Agent\n## Steps\n1. Browse industry news sites and blogs\n2. Track new entrants, funding rounds, acquisitions\n3. Monitor technology trends and sentiment\n4. Synthesize into actionable weekly briefing`,
        },
        {
          id: "price-tracker",
          title: "Price Tracker",
          desc: "Monitor product prices, alert on changes",
          cron: "0 6 * * *",
          code: `# Price Tracker\n## Steps\n1. Open Safari and check pricing sources\n2. Record current prices for [YOUR_PRODUCT]\n3. Compare with previous run's prices\n4. Alert if price dropped more than 5%`,
        },
        {
          id: "paper-digest",
          title: "Academic Paper Digest",
          desc: "Search for papers, create summaries",
          cron: "0 8 * * 1",
          code: `# Academic Paper Digest\n## Steps\n1. Search arxiv.org, Google Scholar, Semantic Scholar\n2. Filter for papers from the last month\n3. Select top 5 most relevant papers\n4. Summarize key contributions for each`,
        },
        {
          id: "job-market-scanner",
          title: "Job Market Scanner",
          desc: "Track job postings, summarize trends",
          cron: "0 7 * * 1",
          code: `# Job Market Scanner\n## Steps\n1. Check LinkedIn Jobs, HN "Who is Hiring"\n2. Track posting count trends, tech stacks\n3. Note salary ranges and remote ratios\n4. Identify new skills appearing in requirements`,
        },
      ],
    },
  ],
  [
    {
      title: "DevOps & Monitoring",
      desc: "Server health checks, backup verification, SSL monitoring, and log analysis.",
      image: "/assets/use-cases/devops.png",
      templates: [
        {
          id: "server-health",
          title: "Server Health Check",
          desc: "Run diagnostics, report status and anomalies",
          cron: "0 */4 * * *",
          code: `# Server Health Check\n## Steps\n1. Check CPU, memory, disk usage\n2. Verify Docker containers and key services\n3. Test DNS resolution and endpoint health\n4. Report status: OK / WARNING / CRITICAL`,
        },
        {
          id: "backup-verifier",
          title: "Backup Verifier",
          desc: "Verify backups exist, are recent, have correct checksums",
          cron: "0 5 * * *",
          code: `# Backup Verifier\n## Steps\n1. Check local and remote backup locations\n2. Verify files exist and are recent (<24h)\n3. Check file sizes (not 0 bytes)\n4. Verify checksums if available`,
        },
        {
          id: "ssl-monitor",
          title: "SSL Certificate Monitor",
          desc: "Check cert expiry dates, alert if expiring soon",
          cron: "0 6 * * 1",
          code: `# SSL Certificate Monitor\n## Steps\n1. For each domain, check certificate via openssl\n2. Parse expiry dates, calculate days remaining\n3. Flag certs expiring within 30 days\n4. Status: OK / WARNING (<30d) / CRITICAL (<7d)`,
        },
        {
          id: "log-analyzer",
          title: "Log Analyzer",
          desc: "Parse logs, identify errors and anomalies",
          cron: "0 8 * * *",
          code: `# Log Analyzer\n## Steps\n1. Read recent log files (last 24 hours)\n2. Categorize: errors, warnings, slow operations\n3. Group similar errors together\n4. Identify new errors not seen before`,
        },
      ],
    },
    {
      title: "Finance & Crypto",
      desc: "DeFi yields, portfolio tracking, stablecoin monitoring, and airdrop alerts.",
      image: "/assets/use-cases/finance.png",
      templates: [
        {
          id: "defi-yield",
          title: "DeFi Yield Monitor",
          desc: "Check yield rates across protocols, report via Telegram",
          cron: "0 8 * * *",
          code: `# DeFi Yield Monitor\n## Steps\n1. Check DeFiLlama, Aave, Compound, Lido\n2. Record current rates for tracked assets\n3. Compare with previous run's rates\n4. Flag significant changes (>0.5% APY shift)`,
        },
        {
          id: "portfolio-tracker",
          title: "Portfolio Tracker",
          desc: "Aggregate positions, daily P&L summary",
          cron: "0 20 * * *",
          code: `# Portfolio Tracker\n## Steps\n1. Check current prices for tracked assets\n2. Calculate position values\n3. Compare with yesterday's values\n4. Generate daily P&L summary with top movers`,
        },
        {
          id: "stablecoin-rates",
          title: "Stablecoin Rate Checker",
          desc: "Monitor rates and peg stability",
          cron: "0 */6 * * *",
          code: `# Stablecoin Rate Checker\n## Steps\n1. Check peg prices: USDT, USDC, DAI, FRAX\n2. Check lending rates across platforms\n3. Flag depegging events (>0.5% deviation)\n4. Note arbitrage opportunities`,
        },
        {
          id: "airdrop-tracker",
          title: "Airdrop Tracker",
          desc: "Track upcoming airdrop eligibility",
          cron: "0 9 * * 1,4",
          code: `# Airdrop Tracker\n## Steps\n1. Check airdrop aggregator sites\n2. Filter for upcoming confirmed/rumored drops\n3. Check eligibility criteria for each\n4. List required actions for this week`,
        },
      ],
    },
  ],
  [
    {
      title: "Personal Productivity",
      desc: "Email drafting, weekly reviews, and structured learning research.",
      image: "/assets/use-cases/productivity.png",
      templates: [
        {
          id: "email-drafter",
          title: "Email Drafter",
          desc: "Review flagged emails, draft responses",
          cron: "0 8 * * 1-5",
          code: `# Email Drafter\n## Steps\n1. Check .cwt/inbox/ for new email files\n2. Understand context and what's being asked\n3. Draft professional response, match tone\n4. Save drafts to .cwt/drafts/`,
        },
        {
          id: "weekly-review",
          title: "Weekly Review Generator",
          desc: "Summarize week's work from git and tasks",
          cron: "0 17 * * 5",
          code: `# Weekly Review Generator\n## Steps\n1. Check \`git log --since="7 days ago" --all\`\n2. Count commits, files changed, lines added\n3. Identify key themes and accomplishments\n4. Generate next week's priorities`,
        },
        {
          id: "learning-agent",
          title: "Learning Agent",
          desc: "Research a topic, compile study notes",
          cron: "0 10 * * 6",
          code: `# Learning Agent\n## Steps\n1. Research [YOUR_TOPIC] via docs and tutorials\n2. Organize: core concepts, techniques, pitfalls\n3. Gather community discussions and resources\n4. Create structured study summary`,
        },
      ],
    },
  ],
]
