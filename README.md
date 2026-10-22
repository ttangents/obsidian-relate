# Relate

Relate gives your notes two-way relationships. When a project lists its notes, each note lists its project too. The links live in ordinary Obsidian properties, so the Properties panel, Bases, the graph, backlinks, and renames all work with them as usual.

Relate also adds a search that understands those relationships. You can type `children of Atlas`, `notes of Q3 Plan about pricing`, or `connected to Acme last month`, and see how Relate read your query before you press Enter. Turn on search by meaning, and the same box also finds notes about an idea when they use different words.

## Getting started

1. Install and enable Relate. A short welcome explains what it does, and the Connections panel opens in the right sidebar.
2. Choose **Find links in your vault**. Relate lists the properties that already link notes, such as `project` or `parent`.
3. Switch on the ones that describe a relationship and name what the other note should call it, for example `project` → `notes`. Relate shows how many links it will add before it changes anything.

If your notes do not use such properties yet, start from a common setup instead: projects and their notes, parents and children, places within places, people and meetings, sources and citations, related notes, or a sequence. Adding a setup changes no notes. You can also set relationships up by hand in **Settings → Relate**: press **+** next to **Relationships** and name the two properties.

## Installation

Search for **Relate** under **Settings → Community plugins → Browse**, then install and enable it.

To install a release by hand, copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/ttangents/obsidian-relate/releases/latest) into `<vault>/.obsidian/plugins/relate/`, then reload Obsidian and enable Relate.

Relate requires Obsidian 1.13.1 or later and works on desktop and mobile.

## Everyday use

- **Connections panel.** Shows the open note's relationships, grouped by type. Use **+** to add one and **×** to remove one. An entry marked “not listed here” means only the other note records the link; its **+** adds it here too.
- **Relationship browser** (ribbon icon, or **Open the relationship browser**). Columns, like Finder: pick a relationship and a starting note, and each column shows the connections of the note selected before it. The last column previews the note. Arrow keys move around, Enter opens the note beside the browser, and Cmd or Ctrl with Enter opens it in a new tab. **Browse this note's relationships** opens the browser on the current note.
- **Linking.** The **+** in the Connections panel offers three ways to link: an existing note, a new note created already linked, or several notes at once. A new note goes in the folder where the other notes of that kind live, unless you choose another. The same actions are commands, and the file menu has **Create a linked note**.
- **Several notes at once.** Select notes in the file explorer, right-click, and choose **Link N notes to a note…**. One Undo reverses the whole batch.
- **Pin the panel.** The pin button keeps the Connections panel on one note, such as a project, while you open its research notes.
- **Loops.** In a relationship that follows chains, such as places within places, Relate refuses a link that would put a note inside itself, and shows the chain. Check links lists any loop already in your notes.
- **Properties panel.** Type a link into a relationship property as you normally would. Relate adds the matching link to the other note.
- **Search notes** (command, or the search button in the browser). Words search note titles and text. These phrases narrow the results:
  - `children of X`, `X's children`, `children: X`
  - `all children of X` follows chains when the relationship allows it
  - `connected to X` covers every relationship
  - `without project` finds notes with no link in a relationship property
  - `in Research/Notes` keeps notes in a folder and its subfolders, and `#draft` keeps notes with a tag
  - phrases nest: `residents of all places of Gondor` finds everyone whose home lies anywhere in Gondor
  - dates: `today`, `yesterday`, `this week`, `last month`, `last 10 days`, `in 2026-09`, `since 2026-01-01`, `before 2026-06`

  Each phrase Relate understands appears as a chip under the search box. Click a chip to switch it to another relationship, to follow or stop following a chain, or to remove it. When a result is more than one link away from the note you named, Relate shows the chain under the result, such as `Boromir → home: Minas Tirith → region: Gondor`. Each note in the chain is a link.
- **Link search results.** Press Shift and Enter in search to link the results to a note. Untick any you want to leave out, choose the relationship and the note, and Relate links them in one batch with one undo. Search then opens again, so you see the result of the change. For example, search `without project in Research/Notes`, link the notes to a paper, and they drop out of the list.
- **How two notes are connected.** Run **How is this note connected to another note?**, or press the button in the browser's preview, and pick a second note. Relate lists up to five short chains of links between the two, shortest first. You can limit the chains to one relationship, and skip busy notes such as an index that links to everything.
- **Tables of linked notes.** **Insert a table of notes linked to this note** adds a Bases table at the cursor that lists the notes on one side of a relationship, such as a project's notes. The table is ordinary Bases syntax, so it keeps working without Relate. **Copy a table of notes linked to this note** puts the same block on the clipboard instead.

## Search by meaning

Search by meaning is off until you turn it on in Relate's settings or with **Turn on search by meaning**. It adds three things:
- Search finds notes about what you describe, not only notes that contain your words. Results found this way say "similar in meaning".
- The Connections panel shows **Similar notes** for the open note.
- The browser's preview lists similar notes, and clicking one browses from it.

It uses [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), a small static embedding model (30 MB, MIT license). Relate runs it in plain JavaScript, with no WebAssembly and no code downloaded at runtime, so it works on phones and tablets too.
- Relate asks before it downloads the model, on each device. A setting synced from another device never starts a download.
- Relate checks the download against the published file's SHA-256 fingerprint and keeps an 8-bit copy (about 8 MB) in this device's browser storage, outside the vault, along with the index. Sync never copies either.
- Indexing happens on the device, and Relate re-indexes a note a moment after you change it. Your notes are not sent anywhere.
- **Remove from this device** in settings deletes the model and the index.

A static model is fast and small, and it understands topics well, but it reads a note as a bag of words rather than as sentences. For a larger model, choose **My own server** and point Relate at any server with an OpenAI-compatible embeddings endpoint, such as Ollama (`http://localhost:11434`, model `nomic-embed-text`) or LM Studio. In that case Relate sends the text of your notes to that server. If the server needs a key, pick it from Obsidian's keychain in Relate's settings; Relate stores only the key's name. Each device asks before it sends notes to a server, so a setting that arrives by sync never sends anything on its own.

## Works with Home Cards

Relate works well with [Home Cards](https://community.obsidian.md/plugins/home-cards), my other plugin, which turns your notes into a start page of cards. You don't need it to use Relate. If you use both, a Home Cards section can list the results of a Relate search, a note's page in Home Cards gives each relationship a section of its own, and its Related to recent work section names the relationship behind each card.

## What's new

After an update, a line at the top of the Connections panel opens the release notes. **Show what's new** opens them at any time, and **Settings → Relate → Announce updates** turns the line off. The first time Relate runs in a vault, a short welcome explains what it does.

## Links from other apps

- `obsidian://relate?search=children%20of%20Atlas` opens Relate's search with that query.
- `obsidian://relate?browse=Atlas` opens the relationship browser on the note named Atlas.

## Safe by design

- Relate writes only plain list-of-links properties through Obsidian's own frontmatter API, and adds no custom syntax or hidden IDs. It edits the note body only when you ask it to insert a table, and that table is a standard Bases block.
- If you uninstall Relate, every link stays where it is and reads correctly. New edits simply stop updating the other note. Reinstall and run **Check links** to catch up.
- **Check links** finds links recorded on one note only, any "only one" property that lists, or is claimed by, more than one note, and notes that a relationship says need a link but have none. It adds missing links but never removes one unless you choose between competing notes, and that choice can be undone. Before applying anything, it rechecks the notes and skips proposals that no longer apply.
- Relate makes its changes one at a time and records each one as it happens. If a batch stops partway, the changes it did make are listed under **Recent changes** and can be undone. If undo cannot reverse a change, because a note is gone or a property is now taken, the change stays listed so you can try again.
- When you edit a note that Relate has just written to, Relate still mirrors your edit. It tells its own writes apart from yours link by link.
- Bulk changes appear under **Recent changes** in Relate's settings with an Undo button, and through the **Undo the last change** command.
- When a removal on one note removes the matching link on another, Relate shows a notice with Undo, which restores the link on both notes.
- Search indexes live in memory. Relate stores nothing in your vault apart from its settings file in the plugin folder.

## Privacy and access

Relate shows no ads, collects no telemetry and needs no account. It reads your notes' properties and text on your device, to keep links in step and to search.

Relate connects to the internet only in two cases, and only after you turn on search by meaning:

- **The built-in model.** Relate asks on each device before it downloads the model, about 30 MB, from [Hugging Face](https://huggingface.co/minishlab/potion-base-8M) at a fixed version. It checks each file against its published SHA-256 fingerprint and saves nothing that does not match.
- **Your own server.** If you choose **My own server**, Relate sends the text of your notes and searches to the address you enter, and to no other. Each device asks before it starts.

Outside your vault, Relate keeps on each device:

- the model and the index for search by meaning, in Obsidian's browser storage;
- in Obsidian's local storage: whether this device agreed to the download or the server, the name of its storage, and the newest release whose notes you have seen.

Inside your vault, Relate keeps only its settings file in its plugin folder, and changes notes only as this page describes.

## Settings

- **Relationships.** Each one is a pair of property names, edited in its own window: nothing changes until you press Save. A relationship can also name the notes that need a link, by folder or by tag, such as every note in `Research/Notes` needing a `project`. Check links lists the notes that have none, each with a button to choose one. Use the same name on both sides for a link that reads the same both ways, such as `related`. Mark a side "only one" when a note can have a single value, such as `parent`. Adding a second value then moves the note and tells you.
- **Update the other note.** On by default. When off, edits you make in the Properties panel stay on one note, while the Connections panel and **Link this note to another note** still update both notes.
- **Remove from the other note too.** On by default. Each removal shows a notice with Undo.
- **Dates in search.** Date modified, date created, or a date property of your choice.
- **Search by meaning.** On or off, the built-in model or your own server, and the status of the index on this device.
- **Announce updates.** After an update, a line at the top of the Connections panel opens the release notes.

## Limits in this version

- Search phrases are English only. Plain word search works in any language.
- Search by meaning works best in English, the language the built-in model was trained on. A server model can cover other languages.

## For other plugins

Other plugins reach Relate through public workspace events, never through its plugin instance:

```ts
const bus: Events = app.workspace;
this.registerEvent(bus.on("relate:ready", (api) => { /* check api.version === 1, then keep it */ }));
this.registerEvent(bus.on("relate:unload", () => { /* forget the api */ }));
this.registerEvent(bus.on("relate:changed", () => { /* links or the meaning index changed */ }));
bus.trigger("relate:request"); // Relate answers with relate:ready if it loaded first
```

`version` changes only when a change would break a caller; new members can appear within a version. The API offers:
- `related(path, property, all?)`: notes related through one relationship, optionally following chains.
- `search(query)`: the same search as the search box, with reasons and, for chained phrases, the chains of links (`paths`).
- `relationships()`: the configured property pairs.
- `similar(path, limit?)`: notes closest in meaning, when search by meaning is on.
- `meaningReady()`: whether search by meaning is ready on this device.
- `connections(path)`: every relationship of a note, named from its side, as `{ prop, path }`.
- `paths(from, to, { property?, maxSteps?, limit?, skipBusy? })`: short chains of links between two notes, as `{ from, prop, to }` steps.
- `connect(from, property, to)` and `disconnect(from, property, to)`: change a link on both notes, with the same checks as the Connections panel. Each resolves to `{ ok, reason? }`.

## Development

```sh
npm install
npm run build   # type check, Obsidian's lint rules, main.js
npm test        # runs the tests
```

`npm run lint` applies [Obsidian's review rules](https://github.com/obsidianmd/eslint-plugin), the checks the community directory runs on each release, to every file in the repository. See [RELEASING.md](RELEASING.md) for the release steps.

## License

[MIT](LICENSE)
