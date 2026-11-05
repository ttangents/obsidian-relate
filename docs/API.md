# Relate for plugin developers

Relate shares its relationships with other plugins. Your plugin can list a note's connections, run Relate's search, ask for notes close in meaning, find the chains of links between two notes, and even add or remove links, with all of Relate's checks and undo. Home Cards uses it to build sections from Relate searches and relationships.

Your plugin never imports Relate, so it keeps working when Relate is missing or turned off. You lose only the extras that need it.

## How the two plugins find each other

Relate talks through four workspace events:

| Event | Who sends it | What it carries |
|---|---|---|
| `relate:ready` | Relate, once Obsidian's layout is ready, and again whenever asked | The API object for version 1 |
| `relate:request` | Your plugin, to ask Relate to send `relate:ready` again | Nothing |
| `relate:unload` | Relate, first thing when it unloads | Nothing |
| `relate:changed` | Relate, when links or the meaning index change, once a burst of changes settles | Nothing |

Listen first, then ask. That way the two plugins connect whichever one loads first.

## Connect in a few lines

```ts
import { Events, Notice, Plugin } from "obsidian";

interface RelateApi {
  version: number;
  related(path: string, property: string, all?: boolean): string[];
  relationships(): { property: string; inverse: string }[];
  connect(from: string, property: string, to: string): Promise<{ ok: boolean; reason?: string }>;
}

export default class MyPlugin extends Plugin {
  private relate: RelateApi | null = null;

  onload(): void {
    // Obsidian's Workspace type lists only its own events, so talk to it as plain Events.
    const bus: Events = this.app.workspace;
    this.registerEvent(bus.on("relate:ready", (api: unknown) => this.attach(api)));
    this.registerEvent(bus.on("relate:unload", () => (this.relate = null)));
    this.registerEvent(bus.on("relate:changed", () => this.refresh()));
    bus.trigger("relate:request");
  }

  private attach(api: unknown): void {
    if (api === this.relate) return; // Same object as before: nothing to do.
    const candidate = api as Partial<RelateApi> | null;
    if (candidate?.version !== 1 || typeof candidate.related !== "function" || typeof candidate.relationships !== "function") {
      // Relate is installed, but with a version this plugin doesn't know.
      // Say so once where your feature would appear.
      this.relate = null;
      return;
    }
    this.relate = candidate as RelateApi;
    this.refresh();
  }

  private refresh(): void {
    // Re-read whatever you show from Relate.
  }
}
```

Check `version` and every method you plan to call before you use them, and keep each call inside your own `try`, so a surprise costs only your Relate feature.

## What you can ask

| Method | What you get back |
|---|---|
| `version` | `1` |
| `relationships()` | The configured pairs, as `{ property, inverse }` |
| `related(path, property, all?)` | Paths of notes related to `path` through `property`, whichever note records the link. With `all`, Relate follows chains where the relationship allows it, up to 12 levels deep |
| `connections(path)` | Every relationship of a note, named from its side, as `{ prop, path }` |
| `search(query)` | A promise of `{ path, reasons, paths }[]`: the same search as Relate's search box. `paths` holds the chain of links behind a result more than one step away. [Searching with Relate](SEARCH.md) lists the phrases |
| `meaningReady()` | True when search by meaning is on and ready on this device |
| `similar(path, limit?)` | Notes closest in meaning, best first, as `{ path, score }`. Empty while search by meaning is off. `limit` defaults to 5, between 1 and 50 |
| `paths(from, to, options?)` | Short chains of links between two notes, shortest first, each a list of `{ from, prop, to }` steps. Options: `property` to keep to one relationship, `maxSteps` (default 6, at most 10), `limit` (default 5, at most 20), and `skipBusy` to avoid notes with more than 35 connections |
| `connect(from, property, to)` | A promise of `{ ok, reason? }`. Links two notes on both sides, with the same checks as the Connections panel |
| `disconnect(from, property, to)` | A promise of `{ ok, reason? }`. Removes the link from both notes |

A link added or removed through `connect` or `disconnect` shows up under Recent changes in Relate's settings, so the reader can always undo it.

## A small example

List a project's notes, and link a new note to it. Add these methods to the plugin class above:

```ts
  projectNotes(): string[] {
    try {
      return this.relate?.related("Projects/Q3 Plan.md", "notes") ?? [];
    } catch {
      return [];
    }
  }

  async addToProject(): Promise<void> {
    if (!this.relate) return;
    try {
      const result = await this.relate.connect("Research/Pricing.md", "project", "Projects/Q3 Plan.md");
      if (!result.ok) new Notice(result.reason ?? "Relate couldn't add that link.");
    } catch {
      new Notice("Relate couldn't add that link.");
    }
  }
```

## Relate's promises

For version 1:

1. Relate freezes the API object, and every plugin gets the same object. Methods return copies, so your code can't change Relate's data by accident.
2. Every method checks its arguments. `connect` and `disconnect` never throw for bad input. They resolve to `{ ok: false, reason }`, with a reason in plain words.
3. Version 1 only grows, by optional additions. A change that could break you would arrive as version 2, next to version 1.
4. Either load order works, as long as you listen for `relate:ready` before you send `relate:request`.

## When Relate turns off

Relate sends `relate:unload` first thing when it unloads, then stops answering. The object you hold goes quiet: read methods return empty results, `meaningReady()` returns false, `search` resolves to an empty list, and `connect` and `disconnect` change nothing and resolve to `{ ok: false, reason: "Relate is not running." }`. Drop the object on `relate:unload`, and wait for the next `relate:ready`.

## Try it out

- Turn Relate off and on in Settings → Community plugins. Your feature should step aside and come back.
- Reload your own plugin with Relate running, and again with Relate off.
- Edit a relationship property and watch for `relate:changed`.

Plugins using this today: [Home Cards](https://community.obsidian.md/plugins/home-cards). Questions or ideas? [Open an issue](https://github.com/ttangents/obsidian-relate/issues).
