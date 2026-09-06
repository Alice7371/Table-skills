# Image and complete-file return

Use this branch when the user explicitly requests web image generation or a
downloadable attachment. It uses the browser's current documented capabilities,
not the text-only receiver. Keep ordinary research routing unchanged.

## Request

Use one agent-owned regular Chat and preserve the user's chosen model/effort.
For an attachment, ask Chat to create an actual downloadable file; the chat reply
should contain only its link and a short status, not a duplicate of the whole file.
For an image, ask for the actual image once. Do not require Markdown/brief markers
or run the text receiver on an image-only response. Persist the observed Chat URL.

## Collect an attachment

Read the visible reply and identify the matching filename and download control.
Where supported, start playwright.waitForEvent("download") before clicking the
observed control. A download event alone is not proof of a complete local file.
Use the path exposed by the download surface; if none is exposed, check only the
expected new filename in the normal download directory. If it is absent, inspect
the browser's download UI rather than searching unrelated local files.

The current download object does not advertise saveAs/path methods; do not invent
them. Copy the downloaded file into the chosen project without overwriting and
return its path. Do not paste the file's contents through the text reader.

## Collect a generated image

Open the matching generated image's full-screen viewer. Use its download control
when it gives a confirmed file. An unconfirmed click is not permission to repeat it.
If needed, use the advertised pageAssets capability:

1. Read its documentation. Inspect the rendered image element's currentSrc and
   naturalWidth/naturalHeight using a read-only DOM call.
2. Call pageAssets.list() and match the observed image URL to its inventory ID.
3. Call pageAssets.bundle({inventoryId, assetIds:[matchedId]}). Use the returned
   local path; do not reconstruct signed URLs or fetch private endpoints yourself.
4. Preserve the downloaded bytes in the project and return the image file.

Resource export retrieves the observed rendered image file; do not claim an
unobserved higher-resolution original. A screenshot is not an image-file download.

## Evidence and limits

On Windows/Codex, the 2026-09-06 sample downloaded a 29,028-character UTF-8 Markdown
attachment through Chrome (36,042 bytes), matching all 1,000 numbered rows and its
SHA256. An in-app Chat generated one image; its Save click gave no download event,
but pageAssets exported a valid 1254 x 1254 PNG. These are separate tested routes,
not proof that every file type, browser combination or image mode works.

Row-by-row/hash comparisons and visual scoring belong to requested testing. In
normal use confirm only the matching artifact, actual file and successful saving;
do not rerun research, review sources or regenerate content for verification.
