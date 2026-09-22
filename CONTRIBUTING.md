# Contributing

Thanks for considering a contribution. Please keep School Agent safe for people working with private academic material.

## Before opening a pull request

- Discuss a substantial change in an issue first.
- Do not include real course material, Canvas URLs tied to a real course, names, grades, access tokens, `.env` files, vaults, or local configuration.
- Use synthetic examples such as `https://canvas.example.edu` and `DEMO-101` in tests, documentation, and screenshots.
- Preserve the read-only Canvas boundary: no Canvas writes, submissions, or discussion replies.
- Do not present AI-policy metadata as enforcement or imply permission from a school or instructor.
- Treat model-produced code as untrusted. The calculator uses Node's `vm` for evaluation, not a security boundary; do not claim an unconditional filesystem or network sandbox.

Run the project checks before opening a PR:

```bash
npm run typecheck
npm run lint
npm test
```

## Pull requests

Explain the user-facing change, tests run, and any privacy, security, or cost implications. Keep changes focused. If you change configuration, commands, or behavior users rely on, update the relevant documentation and examples.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE). Do not contribute course materials or any content you are not allowed to share.
