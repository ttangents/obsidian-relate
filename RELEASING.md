# Releasing Relate

## Each release

1. Update `version` in `manifest.json` and `package.json` to the same value, and add it to `versions.json` with the release's `minAppVersion`. The tests fail if the three disagree.
2. Add the release's notes at the top of `RELEASE_NOTES` in `src/release-notes.ts`: the version, the date, a one-sentence headline for the Connections panel's notice, and the items under New, Improved and Fixed, plus any for readers who also use Home Cards. Set `announce: false` for a release of small fixes, which then shows its notes in the What's new window without a notice. The tests fail if the newest notes do not match the manifest.
3. Run `npm run build` and `npm test`. The build runs Obsidian's review rules over the whole repository and must finish with no errors and no warnings.
4. Commit, then tag the commit with the bare version, with no `v` prefix: `git tag 1.0.0`.
5. Push the commit and the tag, and create a GitHub release for the tag. Attach `main.js`, `manifest.json` and `styles.css` as release assets.
6. The community directory scans each new release within minutes. A release that fails the scan drops out of search until a fixed release replaces it.

`versions.json` lists only versions that exist as GitHub releases. Obsidian reads it to offer an older release to an app too old for the newest one, and a version with no release behind it would fail to install.

## First submission

The community directory at [community.obsidian.md](https://community.obsidian.md) takes submissions from the owner of a public GitHub repository.

1. Create the public repository `ttangents/obsidian-relate`, push `main` and the `1.0.0` tag, and publish the `1.0.0` release with its three assets.
2. Sign in to community.obsidian.md with your Obsidian account, connect GitHub, and choose the repository.
3. Run a preview scan of the `1.0.0` tag from the dashboard and read its results.
4. Submit, agreeing to the Developer Policies. Choose **Free** as the payment label.

The directory reads the listing from the repository: the name, author and description from `manifest.json`, and the page from `README.md`.

| Field | Value |
| --- | --- |
| ID | `relate` |
| Name | Relate |
| Author | Les Joseph |
| Description | Link notes both ways through ordinary properties, then browse and search them by relationship, date or meaning. |
| Repository | `ttangents/obsidian-relate` |
| Payment | Free |

### What the directory checks, and where this repository answers it

- **Manifest:** `id`, `name` and `description` avoid "Obsidian" and "plugin"; the description starts with a verb, ends with a period and stays under 250 characters; `minAppVersion` is the oldest version Relate runs on (1.13.1, for the settings definitions API). The tests check the format.
- **Code:** `eslint.config.mjs` applies `eslint-plugin-obsidianmd`'s recommended rules to every file. Relate uses only Obsidian's API and no Node.js modules, so `isDesktopOnly` stays `false`.
- **Disclosures:** the README's "Privacy and access" section states what Relate reads, stores and sends. Relate connects to the internet only after the reader turns on search by meaning: once per device to download the model from Hugging Face, after asking, or to the reader's own embedding server. It shows no ads, collects no telemetry and needs no account.
- **License:** MIT, in `LICENSE`. The built-in model, potion-base-8M by Minish Lab, is MIT-licensed and is downloaded at runtime, not shipped in the repository.
