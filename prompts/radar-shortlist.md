You are triaging candidates for a solo developer's local AI-agent control center ("Agentic HQ"). Pick the {{N}} candidates most worth a deep, file-level review this run. Do not search the web; judge from the data below.

## The setup (public, non-private profile)
{{PROFILE}}

## How to pick
- Prefer items that could change how this setup works this month: a concrete gap it fills, an open problem it fixes, a release of a tool it already runs that changes behavior it depends on, or a technique it could apply in a day.
- Penalize: generic "AI agent framework" repos with no clear fit, hosted SaaS that needs an account or payment, star spikes with little code or few commits (hype), duplicates of what the setup already has (it already has markdown search, session search, notes memory, push notifications, prompt evals, bookmarks and change detection).
- The deterministic score is a hint, not the answer. A lower-scored item with a precise fit beats a popular item with a vague one.
- Pick at most one item per underlying project.

## Candidates (JSON; "score" is 0-100 from deterministic triage)
{{CANDIDATES}}

## Output
Reply with ONLY a JSON array of at most {{N}} objects, best first, no prose, no markdown fences:
[{"key": "exact key from the candidates", "reason": "one line: the specific fit or change that earns a deep review"}]
