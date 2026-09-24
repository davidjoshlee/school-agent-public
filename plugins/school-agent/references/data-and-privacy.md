# Data and privacy

The vault and SQLite index are local files. Canvas sync uses read-only requests and writes selected course material locally. During generation, selected text from the local vault is transmitted to AI Gateway and the model provider used for that request; “local-first” does not mean generation is offline. Restricted files are excluded by default. See the public [overview](https://github.com/davidjoshlee/school-agent-public/blob/main/docs/OVERVIEW.md) and [security policy](https://github.com/davidjoshlee/school-agent-public/blob/main/SECURITY.md).

Treat the vault, index, config, and `.env` as private. Never paste credentials into chat or command arguments, and never add real course work, vault contents, tokens, private Canvas URLs, or signed download URLs to public examples, fixtures, logs, or commits. Review the selected source paths and policy rules before generation. Policy metadata does not authorize AI use.

Recorded provenance identifies selected source paths and model context, but does not establish that all relevant material was selected or that an answer is correct. A configured monthly spend cap is checked before a model call; it is not a hard billing ceiling for a call already in progress. Usage starts as estimated cost and eligible rows may be reconciled against AI Gateway reports.
