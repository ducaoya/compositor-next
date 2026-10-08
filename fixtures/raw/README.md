# RAW fixtures

Camera RAW files for the importer, so it can be tested without inventing one.

They come from [raw.pixls.us](https://raw.pixls.us/), the community archive that raw decoders are
tested against. Uploaders release their files into the **public domain (CC0)**, which is why these
can live in an MIT repository.

## What is here

| File | Camera | Format | Size |
|---|---|---|---|
| `pro70.crw` | Canon PowerShot Pro70 | CIFF/CRW (1998) | 2.0 MB |

It is deliberately one of the smallest files in the archive: the site serves at roughly 37 KB/s, so
a modern 30 MB RAW is a fifteen-minute download. Use the script below when you want one.

## Fetching more

```sh
node scripts/fetch-raw-fixtures.mjs            # lists what is available
node scripts/fetch-raw-fixtures.mjs sony a7r   # downloads matching files
```

The listing comes from `https://raw.pixls.us/json/getrepository.php?set=all`, an undocumented
endpoint the site's own pages use. Download links are
`https://raw.pixls.us/getfile.php/<id>/nice/<name>`, and the name has to be percent-encoded before a
request will take it.

**Do not run these in the foreground.** At the site's speed a handful of files is tens of minutes;
the script runs in the background, logs progress, and can be polled.
