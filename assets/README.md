# assets/ — Item Image Directory

Place item image files in this directory. They will be loaded by the inventory app when referenced in the CSV.

## CSV Column: `images`

Add an `images` column to your CSV. Multiple images per item are supported, separated by a semicolon (`;`).

### CSV example

```csv
Manufacturer,itemnumber,item name,itemnumber2,itemnumber3,Numberofitems,Inventorylocation,Comments,images
HÄNY,955.248B,O-RING 102 X 4,None,1001007,7,Best,None,item-a3f8bc12.png
HÄNY,613.034,IMPELLER DISC,2261-ED-11,None,3,Best,None,item-d7e2a091.png;item-f04c3b77.png
```

## Naming Convention

Use opaque/obfuscated filenames to avoid exposing item identity in public directories:

```
item-<random8chars>.<ext>
```

Examples:
- `item-a3f8bc12.png`
- `item-d7e2a091.jpg`
- `item-f04c3b77.webp`

## Supported formats

`png`, `jpg`, `jpeg`, `webp`, `gif`

## Notes

- Files not found (broken paths) are silently hidden in the gallery.
- Images are displayed in a horizontal scrollable strip on the item detail page.
- Click any image to open it in a full-screen lightbox.
- The `assets/` folder should be in the **same directory** as `index.html`.
