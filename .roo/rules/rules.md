# Code Quality Rules

1. Focused Validation:

    - Prioritize the requested implementation. Do not treat every edit as a requirement to add tests or run validation.
    - Add or run tests only when explicitly requested, required by an applicable mandatory gate, or necessary to resolve a specific correctness, security, or integration risk in the changed behavior. Identify that reason before expanding validation.
    - Choose the smallest relevant test or check. Documentation-only, wording, and formatting changes normally need inspection rather than executable tests unless they affect generated output or a concrete behavior contract.
    - Reuse valid results for the current code state, including results reported by a child task. Rerun only when relevant code or dependencies changed, evidence is missing or stale, a check failed, or a mandatory gate requires it.
    - Batch necessary validation after a coherent change. Do not routinely combine broad test suites, builds, lint, and type checks after every edit. Do not create another subtask merely to repeat completed validation.
    - "Tests pass" refers to the required, scoped checks, not every test in the repository. Broader runs need an explicit request, mandatory gate, or concrete risk that focused checks cannot resolve. Do not bypass required CI or commit hooks.
    - Stop when the deliverable and necessary validation are complete. Report what was checked, what was not checked, and any failures or blockers; never claim unrun checks passed. Skipping unnecessary checks is not a reason to delay completion.

    When a Vitest run is necessary:

    - The vitest framework is used for testing; the `vi`, `describe`, `test`, `it`, etc functions are defined by default in `tsconfig.json` and therefore don't need to be imported from `vitest`
    - Tests must be run from the same directory as the `package.json` file that specifies `vitest` in `devDependencies`
    - Run tests with: `npx vitest run <relative-path-from-workspace-root>`
    - Do NOT run tests from project root - this causes "vitest: command not found" error
    - Tests must be run from inside the correct workspace:
        - Backend tests: `cd src && npx vitest run path/to/test-file` (don't include `src/` in path)
        - UI tests: `cd webview-ui && npx vitest run src/path/to/test-file`
    - Example: For `src/tests/user.test.ts`, run `cd src && npx vitest run tests/user.test.ts` NOT `npx vitest run src/tests/user.test.ts`
    - Prefer the direct focused Vitest command above over package test scripts that trigger unnecessary pretest builds. Use the build pipeline only when the selected check actually needs its artifacts or a mandatory gate requires it.

2. Lint Rules:

    - Never disable any lint rules without explicit user approval

3. Styling Guidelines:

    - Use Tailwind CSS classes instead of inline style objects for new markup
    - VSCode CSS variables must be added to webview-ui/src/index.css before using them in Tailwind classes
    - Example: `<div className="text-md text-vscode-descriptionForeground mb-2" />` instead of style objects
