# Evidence selector verification — Tasks

**Plan:** [`plan.md`](plan.md) · **Spec:** [`spec.md`](spec.md)

Work top to bottom. Each task ends with a green focused test and a commit.
Prefix every shell session with:

```bash
export PATH="$HOME/.local/node-v24.22.1-linux-x64/bin:$PATH"
```

The `ui-evidence` project is the whole stage gate here:
`npx vitest run --project ui-evidence`. `npm run check:fast` is required only at
the end, and its `lint` half cannot run on a 4 GB host without swap (see
`plan.md#environment`).

| Task | Requirement | Command                                                        |
| ---- | ----------- | -------------------------------------------------------------- |
| 1    | R1          | `npx vitest run --project ui-evidence ui/blueprint/evidence.test.mjs` |
| 2    | R2          | `npx vitest run --project ui-evidence ui/blueprint/gate.test.mjs`     |
| 3    | R3          | `npx vitest run --project ui-evidence ui/blueprint/package-verify.test.mjs` |
| 4    | R4          | `npx vitest run --project ui-evidence ui/blueprint/manifest.test.mjs ui/blueprint/schemas.test.mjs` |
| 5    | R5          | `npm run docs:check`                                            |

Stage gate after Task 5: `npx vitest run --project ui-evidence` and
`npm run docs:check` exit 0.
