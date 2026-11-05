# The Relate guide

This guide covers everything Relate can do, from adding your first link to checking a whole vault. New here? The [README](../README.md) gets you started in three steps, and [Searching with Relate](SEARCH.md) has every search phrase.

## Relationships, in a nutshell

A relationship is a pair of property names, one for each side. With `project` ↔ `notes`, a research note says `project: [[Q3 Plan]]`, and Q3 Plan says `notes: [[Pricing research]]`. Change either side, and Relate updates the other.

- Use the same name on both sides for a link that reads the same both ways, such as `related`.
- Mark a side "only one" when a note can have just one value, such as `parent`. Give it a second value, and Relate swaps the old value for the new one and tells you.
- A relationship can also say which notes should have a link, by folder or by tag, such as "every note in `Research/Notes` needs a `project`". Check links then lists the notes that have none.

Set relationships up in Settings → Relate: press + next to Relationships, or start from "Find links in your vault" or a ready-made setup. Each relationship opens in its own window, and Relate changes no notes until you press Save.

## The Connections panel

The Connections panel shows the open note's relationships, grouped by type.

- Press + to add a link and × to remove one.
- An entry marked "not listed here" means only the other note records the link. Its + adds the link here too.
- The pin button keeps the panel on one note, such as a project, while you open its research notes one after another.
- With search by meaning on, the panel also shows Similar notes for the open note.

## The relationship browser

Open it from the ribbon, or with "Open the relationship browser". It works like a file browser's column view: pick a relationship and a starting note, and each column shows the connections of the note you picked before it. The last column previews the note.

- The arrow keys move around.
- Enter opens the note beside the browser, and Cmd or Ctrl with Enter opens it in a new tab.
- "Browse this note's relationships" opens the browser on the note you are reading.

## Linking notes

The + in the Connections panel offers three ways to link:

- an existing note;
- a new note, created already linked. It lands in the folder where notes of that kind already live, unless you pick another;
- several notes at once.

The same actions are commands too, and the file menu offers "Create a linked note".

Prefer the Properties panel? Type a link into a relationship property as you always do, and Relate adds the matching link to the other note.

### Several notes at once

Select notes in the file explorer, right-click, and choose "Link N notes to a note…". One Undo reverses the whole batch.

You can also link search results: press Shift and Enter in search, uncheck any you want to leave out, choose the relationship and the note, and Relate links them all.

### No loops

In a relationship that follows chains, such as places within places, Relate refuses a link that would put a note inside itself, and shows you the chain that would loop. Check links lists any loop already in your notes.

## How two notes connect

Run "How is this note connected to another note?", or press the button in the browser's preview, then pick a second note. Relate lists up to five short chains of links between the two, shortest first. You can limit the chains to one relationship, and skip busy notes, such as an index that links to everything.

## Tables of linked notes

"Insert a table of notes linked to this note" adds a Bases table at the cursor, listing the notes on one side of a relationship, such as a project's notes. It's ordinary Bases syntax, so the table keeps working without Relate. "Copy a table of notes linked to this note" puts the same block on the clipboard instead.

## Check links

"Check links" looks over your vault and finds:

- links that only one side records;
- an "only one" property that lists, or is claimed by, more than one note;
- notes that a relationship says need a link but have none;
- loops in relationships that follow chains.

It adds missing links. It removes a link only when you choose between competing notes, and you can undo that choice. Before it applies a fix, it checks the notes again and skips any fix that no longer fits.

## Undo, any time

Every change Relate makes appears under Recent changes in Relate's settings, with an Undo button, and the "Undo the last change" command undoes the newest one. That includes the links Relate adds back or removes after you edit a property: undoing one puts every note back as it was before your edit.

- When your edit removes a link from another note, or moves a note from one "only one" property to another, Relate shows a notice with Undo.
- Relate makes its changes one at a time and records each one as it goes. If a batch stops partway, Recent changes lists the changes it did make, and you can undo them.
- If Undo can't reverse a change, because a note is gone or a property is now taken, the change stays listed so you can try again later.
- Recent changes lists a batch of more than about 8,000 changed links without an Undo button, and Relate tells you when that happens.
- When you edit a note Relate has just written to, Relate still mirrors your edit. It tells its own writes apart from yours, link by link.

## Search by meaning

Search by meaning is off until you turn it on, in Relate's settings or with "Turn on search by meaning". Then:

- search also finds notes about what you describe, even when they use different words. Those results say "similar in meaning";
- the Connections panel shows Similar notes for the open note;
- the browser's preview lists similar notes, and clicking one browses from it.

Relate uses [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), a small model (30 MB, MIT license) that runs inside Obsidian itself, so it works on phones and tablets too. Relate downloads the model's data and no code.

- Relate asks before it downloads the model, on each device. A setting that arrives by sync never starts a download.
- Relate checks the download against the published file's SHA-256 fingerprint, and keeps a compressed copy (about 8 MB) and the index in this device's browser storage, outside your vault. Sync never copies either. If browser storage isn't available, Relate asks before each download, and the model then lasts until Obsidian closes.
- Relate builds the index on your device, and updates a note's entry a moment after you change it. Your notes stay on the device.
- "Remove from this device" in settings deletes the model, the index and their database.

The built-in model is fast and small, and it understands topics well. It looks at which words a note uses, without following how its sentences fit together. For a bigger model, choose "My own server" and point Relate at any server with an OpenAI-compatible embeddings endpoint, such as Ollama (`http://localhost:11434`, model `nomic-embed-text`) or LM Studio.

With your own server, Relate sends the text of your notes to that server. If the server needs a key, pick it from Obsidian's keychain in Relate's settings, and Relate stores only the key's name. Relate asks on each device before it sends notes to a server, naming the exact address, so a setting that arrives by sync never sends anything by itself, and changing the address asks again. If the address uses plain `http` on another machine, Relate warns you that your notes and any key travel unencrypted.

## Settings

- Relationships: your property pairs, each edited in its own window.
- Update the other note: on by default. Turn it off, and edits you make in the Properties panel stay on one note, while the Connections panel and "Link this note to another note" still update both notes.
- Remove from the other note too: on by default. Each removal shows a notice with Undo.
- Dates in search: date modified, date created, or a date property of your choice.
- Search by meaning: on or off, the built-in model or your own server, and how the index is doing on this device.
- Announce updates: whether a line at the top of the Connections panel announces each update.

## What's new

After an update, a line at the top of the Connections panel opens the release notes. "Show what's new" opens them any time. The first time Relate runs in a vault, a short welcome explains what it does.

## Links from other apps

- `obsidian://relate?search=children%20of%20Atlas` opens Relate's search with that query.
- `obsidian://relate?browse=Atlas` opens the relationship browser on the note named Atlas.

## If something goes wrong

- If Relate's settings file is damaged, Relate uses safe values, tells you what was wrong, and copies the original to `data.backup.json` in its plugin folder before it saves anything.
- The link and word indexes live in memory, so a restart rebuilds them. The meaning index stays in browser storage.
- If you uninstall Relate, every link stays where it is and reads correctly. New edits stop updating the other note. Reinstall and run Check links to catch up.

## Good to know

- Search phrases are English only for now. Plain word search works in any language.
- Search by meaning works best in English, the language the built-in model learned. A model on your own server can cover other languages.
