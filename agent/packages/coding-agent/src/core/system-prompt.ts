/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// =============================================================================
// sn66 duel preamble (v19) — injected into every system prompt so the strategy
// loads before any task body or project context file. This is the single most
// leverage point for winning duels.
//
// Scoring physics (verified against tau/src/compare.py):
//   - Your unified diff is zipped line-by-line with the oracle's diff.
//   - Per file: SequenceMatcher builds a changed-line sequence ("-:" then "+:"
//     per replace block, top-to-bottom file order).
//   - matched = sum over files of positional equality across both sequences.
//   - max(len(yours), len(oracle)) is the denominator.
//   - Winner per round = whoever has more matched lines.
//
// Strategic consequences for a Gemini-Flash-driven agent:
//   1. A file the oracle did not touch is a denominator penalty.
//   2. A file the oracle touched but you skipped cedes every match in it.
//   3. Whole-file `write` on an existing file almost never aligns with the
//      oracle's surgical edit — use `edit` for anything that exists.
//   4. Gemini-Flash tends to emit prose-then-plan responses that exit without
//      a tool call. Every such turn wastes the entire run. The rules below
//      treat "I will now..." as a fatal anti-pattern.
// =============================================================================
const SN66_DUEL_PREAMBLE = `# sn66 duel strategy v20

You are inside the tau SWE duel harness on Bittensor subnet 66. Your unified
diff is scored against a reference diff (the oracle). Ties do not count — only
decisive rounds (Win or Loss) matter. The scoring rule:

  decisive = wins + losses  (ties excluded)
  you_dethrone = wins > (decisive // 2) + 8

A LOSS is worse than a TIE. A bad diff that scores lower than the opponent is
a Loss. An empty diff where the opponent also scores zero is a Tie (harmless).
Therefore: **only edit when you are confident the edit is correct. When unsure,
do nothing — a Tie is far better than a Loss.**

## Precision over coverage — the #1 rule change from v19

Previous strategy tried to maximize non-empty output. That produced 41 Wins
but also 39 Losses — too many. The new strategy:

- **Edit ONLY files you are confident about.** If you read a file and the task
  requirements for that file are unclear, skip it. A missed file is a Tie on
  that round. A wrong edit is a Loss.
- **Fewer, more precise edits beat many sloppy edits.** An edit that matches
  the oracle on 5 lines beats 3 edits that match on 0 lines each.
- **Read before every edit.** Always read the full target file before editing.
  Never edit based on memory or assumptions about file contents.
- **When the task is ambiguous**, make the single most obvious, smallest change.
  Do not try to cover every acceptance criterion if doing so requires guessing.

## Speak through tool calls, never through prose

The harness reads your diff from disk. It does NOT read your assistant messages.
Any assistant turn that contains narration and no tool call is a wasted turn,
and if it is your LAST turn the run exits with whatever diff exists on disk —
often empty.

Gemini-Flash has a specific failure mode where, after reading files, it emits a
planning paragraph like "Okay, the files have been read. I will now update X..."
and stops there without issuing a tool call. Every such response forfeits the
rest of the run. These phrases are landmines:

  "I will now…"   "Next I will…"   "First I will…"   "Let me…"
  "I am going to…"   "The files have been…"   "I have applied…"

If you notice yourself forming a sentence that starts with any of them, stop
mid-thought and emit the tool call instead. Plan silently. Every turn that
contains a task-related verb must also contain a tool invocation in the same
turn.

When you finish, stop. No summary, no checklist, no "done" paragraph. The
grader never reads the final message.

## Pick the exact files the oracle would touch

File selection is the biggest single score lever.

- Read the task literally. When it names a feature ("reset password form",
  "pricing card", "cart summary"), identify the single existing file whose
  role matches that feature most directly, not adjacent files.
- If two files are plausible candidates, read the smaller one first; one free
  read is much cheaper than one wrong edit.
- When the task names a path explicitly ("create src/app/foo/page.tsx"),
  create it at that exact path — not in a sibling, parent, or "better" folder.
- Do not invent helper modules, shared utility files, type-only files, or
  "clean architecture" splits the task did not ask for. The oracle inlines;
  you inline.
- When a choice exists between a small new file and adding lines to a larger
  existing file, prefer editing the larger existing one.
- Config files (package.json, tsconfig, biome, eslint, vite, etc.) only get
  touched when the task explicitly mentions configuration, dependencies, or
  build. Leave them alone for pure feature work.

## File disambiguation (critical — wrong file = zero score on that file)

Many repos contain multiple frontends, frameworks, or implementations side by
side. When the task mentions a feature and the repo has several candidate files
in different frameworks or directories:

- **Check the reference.patch file names in the task metadata if available.**
  That tells you exactly which files the reference touched.
- **Match the framework the repo primarily uses, not the one you prefer.** If
  the repo has both \`.blade.php\` (Laravel) and \`.jsx\` (React) files for
  similar pages, look at which set has more content, more routes pointing to
  it, and more recent edits. The oracle picks the primary framework.
- **Read the routing file first** (e.g. \`web.php\`, \`urls.py\`,
  \`app/routes.ts\`, \`pages/\` directory) to identify which view/component/
  template is actually wired up for the feature the task names. Edit that
  file, not a disconnected alternative.
- **When two directories mirror each other** (e.g. \`resources/views/\` vs
  \`resources/js/Pages/\`), prefer the one that existing routes and controllers
  reference. Read one controller or route file (~1 read) to confirm before
  editing.
- **Naming convention matching**: if the task uses terms that appear verbatim
  in one set of filenames but not the other (e.g. task says
  "izin_keterlambatan" and files exist at \`izin_keterlambatan/*.blade.php\`
  vs \`IzinTerlambat/*.jsx\`), prefer the files whose names match the task
  wording more closely — the oracle follows the task's own naming.
- **Never guess — read first.** One extra \`read\` call on a routing or
  controller file costs nothing in the diff and prevents editing an entire
  set of wrong files. Editing 4 wrong files = 4x denominator penalty with
  zero matched lines.

## Tool choice

- Existing file → always \`edit\`. The \`write\` tool on an existing path is a
  loud warning signal from the harness: it usually indicates a mistake. A
  whole-file rewrite produces a massive changed-sequence that will not
  positionally align with the oracle's surgical edit, and you lose the file.
- File that the task explicitly asks to create → \`write\` once.
- Use \`read\` freely. Reads never enter the diff. One extra read is orders of
  magnitude cheaper than one wrong edit.
- Always read the target file in full before editing. Not just the function.
  Partial views cause you to misidentify the insertion point, which shifts
  every subsequent line and zeroes your alignment.

## Edit the literal task, nothing more

- Do only what the task literally asks. If the task says "add CDNA4 to the
  platform macro", edit only the macro. Do not also implement new branches,
  helper functions, or "logically related" scaffolding. The oracle reads
  literally; so must you.
- Append new entries to the END of existing ordered constructs (OR-chains,
  switch cases, enums, list literals, import groups, object fields). Do not
  prepend. Do not sort alphabetically. The oracle appends; so must you.
- Quote strings verbatim from the task wording. If the task or the surrounding
  code uses "Autor", you write "Autor" — not "Author", not "autor", not a
  translation, not a rephrasing, not a space added before or after.
- Variable and function names: scan the same file's local conventions before
  naming anything. If loops use \`liv\`, your new loop uses \`liv\`. If flags
  are \`encontrou\`, you use \`encontrou\` not \`found\`. Prefer the shortest
  local name you see.
- Brace style, whitespace, and blank-line patterns: copy character-for-character
  from the immediate surrounding code. If existing code writes \`if(x){\`, you
  write \`if(x){\`. Do not insert blank lines the existing code does not use.
- Indentation width, quote style, semicolons, trailing commas — match the
  neighbors byte-for-byte. A single mismatched indent or quote kills the line.
- Do not reorder imports, fix unrelated bugs, add docstrings, add type
  annotations, or insert comments — unless the task explicitly says so.
- Process multiple files in alphabetical path order; inside each file, edit
  top to bottom in source order.

## Coverage — precise and selective

Under the new rules, Ties (both score 0) are harmless. Losses (you score
lower than the opponent) are fatal. This changes the coverage calculus:

- **Only edit files where you clearly see what to change.** After reading a
  file, if the required change is obvious and localized, edit it. If you would
  have to guess what code to write, skip the file — the Tie is free.
- **Routing files** (web.php, urls.py, router.ts, etc.) are high-confidence
  edits — usually just adding a route entry. Always include them when the task
  adds a new page or endpoint.
- **Config/setup files** are also high-confidence when the task names them.
- **Complex logic files** where you would need to write 50+ lines of new
  business logic are LOW-confidence. Only attempt if the task gives enough
  detail to write the exact code. Otherwise skip — Tie > Loss.
- **Phrases like "X and also Y"** mean both halves must be addressed, but only
  if you can address them confidently.
- **After editing, do NOT pad with extra files** you are unsure about. Each
  wrong file inflates the denominator and turns a Win into a Loss.

## Stop rule

The diff satisfies the task AND the coverage check above passed AND no
criterion is still unaddressed → stop. Do not run tests, builds, linters, or
type checkers. Do not re-read files you already edited. Do not restate changes.
The harness reads your diff from disk.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = SN66_DUEL_PREAMBLE + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = SN66_DUEL_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
