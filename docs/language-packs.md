# Language packs

The interface is translated from JSON files. English is the default and the fallback, so a pack can
translate as much or as little as it likes: every key it leaves out reads in English rather than
showing a key name.

## Installing one

**Edit › Language › Install Language Pack…**, choose a `.json` file, and the interface switches to
it. The pack is copied into the app's data folder, so it is still there after a restart.

**Edit › Language › Open Language Folder** opens that folder. Dropping a `.json` file into it and
choosing **Reload Language Packs** does the same thing by hand — a pack is just a file, and nothing
has to be rebuilt, downloaded, or restarted.

## Writing one

Copy [`../examples/language-pack.example.json`](../examples/language-pack.example.json) and work
through it. The three fields a pack must have are `locale`, `name`, and `messages`:

```json
{
  "locale": "fr",
  "name": "Français",
  "englishName": "French",
  "version": "0.1.0",
  "authors": ["Your name"],
  "messages": {
    "menu": { "file": "Fichier", "edit": "Édition" },
    "status": { "noSelection": "Aucune sélection" }
  }
}
```

- **`locale`** is a BCP 47 tag — `fr`, `pt-BR`, `zh-TW`. It is the file name the pack is stored
  under, so it must not contain `/`, `\`, `:` or `.`.
- **`name`** is what the language calls itself, and it is what the picker shows. Someone whose
  interface is in the wrong language cannot read `French`.
- **`messages`** mirrors [`../web/src/i18n/locales/en.json`](../web/src/i18n/locales/en.json)
  exactly. That file is the source of truth: it lists every key, and it is the file to translate
  from.

`englishName`, `version`, and `authors` are optional and are shown in the picker.

## What to translate, and what not to

Translate everything under `menu`, `options`, `layers`, `properties`, `status`, `canvas`,
`newCanvas`, `tools`, `language`, `message`, `common`, and `error`. Change `locale` and `name` to
your own.

Do **not** translate the keys under `blendModes` and `sampling` — translate their *values*. The
`.comp` format stores blend modes as English names (`"Multiply"`, `"Linear Dodge (Add)"`), and the
picker shows a translated label while writing the English one, so a project stays readable by the
other app whichever language you use.

Keep placeholders exactly as they are: `{name}`, `{width}`, `{count}` and the rest are substituted
at runtime. A test checks that both languages use the same placeholders in the same keys.

## Checking a pack

The app refuses a file that is not a pack and tells you why. Beyond that, the safest check is to
switch to it and read the interface — a key you have not translated shows in English, which is
visible rather than broken.

For the repository's own locales, `web/src/i18n/__tests__/messages.test.ts` enforces that English
and Chinese cover exactly the same keys, use the same placeholders, have no empty strings, and name
every blend mode and sampling the format holds.

## Adding a language to the app itself

Put the translated file next to the others in `web/src/i18n/locales/`, add it to `BUILT_IN` in
`web/src/i18n/index.ts`, and add its keys to the test's expectations. That is all: a built-in locale
is the same shape as an installed pack, only shipped inside the app.
