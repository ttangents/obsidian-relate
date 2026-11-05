# Relate

Relate links your notes both ways. Add a note to a project, and the project lists the note too. Name a meeting's attendees, and each person's note remembers the meeting. The links live in ordinary Obsidian properties, so the Properties panel, Bases, the graph, backlinks and renames all keep working just as they do today.

Then you can explore. Type `children of Atlas`, `notes of Q3 Plan about pricing` or `connected to Acme last month`, and Relate shows you how it read your search before you press Enter. Turn on search by meaning, and the same box finds notes about an idea even when they use different words.

## Get started

1. Open Settings → Community plugins → Browse, search for Relate, then install it and turn it on. A short welcome says hello, and the Connections panel opens in the right sidebar.
2. Choose "Find links in your vault". Relate lists the properties that already link your notes, such as `project` or `parent`.
3. Switch on the ones that describe a relationship, and name what the other note should call it, for example `project` → `notes`. Relate tells you how many links it will add before it changes a thing.

Starting fresh? Pick a ready-made setup instead: projects and their notes, parents and children, places within places, people and meetings, sources and citations, related notes, or a sequence. Adding a setup changes no notes.

Relate works on desktop and mobile with Obsidian 1.13.1 or later.

## What you can do

- See a note's family at a glance. The Connections panel shows every relationship of the open note, grouped by type, with + to add a link and × to remove one.
- Browse in columns. The relationship browser lays your notes out side by side, like a file browser's column view. Pick a starting note, and each column shows the connections of the note you chose before it.
- Link many notes at once. Select notes in the file explorer, right-click, and link them all to a project in one go. One Undo reverses the whole batch, up to about 8,000 links.
- Search by relationship, date, folder and tag, and combine them freely: `residents of all places of Gondor` finds everyone whose home lies anywhere in Gondor.
- Find out how two notes connect. Relate shows up to five short chains of links between them, shortest first.
- Drop a table of linked notes into a note. It's an ordinary Bases block, so it keeps working without Relate.
- Find notes that are close in meaning, with a small model that runs right on your device.

## How Relate keeps your links safe

Relate writes plain lists of links into your properties, through Obsidian's own property tools. It adds no special syntax and no hidden IDs, so if you ever uninstall it, every link stays put and reads correctly.

Every change Relate makes shows up under Recent changes in its settings, with an Undo button. "Check links" finds links that only one side records, and adds what is missing after you say yes. If a batch stops partway, the changes it made stay listed so you can undo them.

## Learn more

- [The Relate guide](docs/GUIDE.md) covers the Connections panel, the browser, linking, checking links, settings and links from other apps.
- [Searching with Relate](docs/SEARCH.md) explains every search phrase, with examples.
- [Relate for plugin developers](docs/API.md) shows how another plugin can read and change relationships.

## Plays well with others

- [Home Cards](https://community.obsidian.md/plugins/home-cards), my plugin that gives your vault a start page of note cards, gains a few extras when Relate runs. A section can list the results of a Relate search, a note's page gives each relationship a section of its own, and "Related to recent work" names the relationship behind each card.
- [Pagewise](https://community.obsidian.md/plugins/pagewise), my plugin that lays out notes as word-processor pages, lists the notes that link to a page through Relate as labels under its linked mentions.

You don't need either of them to use Relate.

## Your privacy

Relate shows no ads, collects no usage data and needs no account. It reads your notes' properties and text on your device, to keep links in step and to search.

Relate goes online in only two cases, and only after you turn on search by meaning:

- The built-in model, from Hugging Face. Search by meaning needs a small model to turn notes into numbers it can compare. Relate asks on each device before it downloads the model, about 30 MB, from [Hugging Face](https://huggingface.co/minishlab/potion-base-8M) at a fixed version. It checks each file against its published SHA-256 fingerprint and keeps only files that match. The model is data, and Relate downloads no code.
- Your own server, if you choose one. If you'd rather use a larger model, choose "My own server". Relate then sends the text of your notes and searches to the address you enter, and to no other, so that server can index them. Relate asks on each device before it starts, naming the address, and asks again if the address changes.

Outside your vault, Relate keeps on each device:

- the model and the index for search by meaning, in Obsidian's browser storage;
- in Obsidian's local storage, whether this device agreed to the download or the server, the name of the database that holds the model and index, and the newest release notes you have seen.

Inside your vault, Relate keeps only files in its own plugin folder: its settings (`data.json`), its undo history (`history.json`), and, if its settings file was ever damaged, a copy of the damaged file (`data.backup.json`). It changes notes only in the ways this page describes.

Relate lists every note in the vault to keep its index of links, and reads notes' text for search. It writes to the clipboard only when you run "Copy a table of notes linked to this note", and it never reads the clipboard.

## Install by hand

Copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/ttangents/obsidian-relate/releases/latest) into `<your vault>/.obsidian/plugins/relate/`, reload Obsidian, and turn Relate on.

## Build it yourself

```sh
npm ci
npm run build   # type check, Obsidian's review rules, main.js
npm test        # runs the tests with Vitest
```

Two tests compare the built-in model against reference embeddings. They run when `RELATE_MODEL` names a folder holding potion-base-8M's `tokenizer.json` and `model.safetensors`, and they skip themselves otherwise.

`npm run lint` applies [Obsidian's review rules](https://github.com/obsidianmd/eslint-plugin), the same checks the community directory runs on each release.

## License

[MIT](LICENSE)
