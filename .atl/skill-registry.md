# Skill Registry — merchantai

Generated: 2026-06-30
Artifact store: engram
Project: merchantai

## Convention Files

| File | Purpose |
| ---- | ------- |
| `/Users/samueldavidalzatetejada/Developer/merchantai/CLAUDE.md` | Inventory FIFO ledger rules, e-invoicing (MATIAS/DIAN) conventions, Smart Stock logic |

## User-Level Skills

> Source: `~/.claude/skills/`
> Excludes: `sdd-*`, `_shared`

| Name | Trigger / Description | Scope | Path |
| ---- | --------------------- | ----- | ---- |
| `branch-pr` | Creating, opening, or preparing PRs for review | user | `~/.claude/skills/branch-pr/SKILL.md` |
| `chained-pr` | PRs over 400 lines, stacked PRs, review slices — split oversized changes into chained PRs | user | `~/.claude/skills/chained-pr/SKILL.md` |
| `cognitive-doc-design` | Writing guides, READMEs, RFCs, onboarding, architecture, or review-facing docs | user | `~/.claude/skills/cognitive-doc-design/SKILL.md` |
| `comment-writer` | PR feedback, issue replies, reviews, Slack messages, or GitHub comments | user | `~/.claude/skills/comment-writer/SKILL.md` |
| `issue-creation` | Creating GitHub issues, bug reports, or feature requests | user | `~/.claude/skills/issue-creation/SKILL.md` |
| `judgment-day` | Adversarial review, dual review, judgment day — blind dual review then re-judge | user | `~/.claude/skills/judgment-day/SKILL.md` |
| `ship-to-main` | Ship, ship to main, subir a main — branch, commit, squash-PR and merge fast | user | `~/.claude/skills/ship-to-main/SKILL.md` |
| `skill-creator` | New skills, agent instructions, documenting AI usage patterns | user | `~/.claude/skills/skill-creator/SKILL.md` |
| `skill-improver` | Improve skills, audit skills, refactor skills, skill quality | user | `~/.claude/skills/skill-improver/SKILL.md` |
| `work-unit-commits` | Implementation, commit splitting, chained PRs, keeping tests and docs with code | user | `~/.claude/skills/work-unit-commits/SKILL.md` |

## Project-Level Skills

None found. No `.atl/skills/`, `.claude/skills/`, or equivalent directory in project root.

## Notes

- `go-testing` skill exists at `~/.claude/skills/go-testing/SKILL.md` but is excluded — project uses TypeScript/Vitest, not Go.
- SDD skills (`sdd-*`) and `_shared` are excluded per registry scan rules.
- This registry is an index of exact paths. Sub-agents receive these paths and read the full `SKILL.md` source directly.
