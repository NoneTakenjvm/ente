# Compress follow-up — GPU, filters, progress, selection chrome

Plan only. Ready to implement when you say go. No remaining product forks.

## Locked decisions

| Topic | Decision |
|---|---|
| Compress filter vs gallery | **Independent** state. Gallery tags do not empty Compress. |
| Filter vs sort | **Filter only.** Tags, photos/videos, favorites, cropped. **No** stamp, shuffle, Options sort, kit likeness, or query-driven reorder. Grid order is always **largest file first** (`sortCompressCandidatesBySize`). |
| Size overlay | Compress picker only. Bottom-left chip. |
| Photos | Keep AVIF. CPU encode is expected. |
| Video + broken AAC | Keep hardware H.264. Remux audio separately. |
| Audio last resort | **Skip the file.** Never replace a clip with a silent MP4. Video with **no** audio track is fine as video-only. |
| Batch video size | Cap long edge at **1920**. Viewer preview stays **1280**. Stills stay full-res PhotoHoard. |
| Upload progress | **Thread real %** through encrypt/PUT, not a spinner. |
| CRF UI | Removed everywhere. Internal CRF **28**. |
| GIFs in footer | Count with **photos**. |
| Keep as-is | Skip compressed, min-size dropdown, PhotoHoard skip-if-already-small. |

## Why GPU/CPU still looks “broken”

### Images — expected

PhotoHoard routes photos to **AVIF**. Chrome encode is software (`convertToBlob(avif)` or `@jsquash/avif` WASM). Task Manager **GPU 3D** will not move. That is not a failed ship of the last batch.

What *would* mean the last batch failed: output still `.jpg`, or a JPEG quality slider in settings.

### Videos — two problems, often stacked

1. **Silent ffmpeg fallback.** `compressMediaBytes` swallows every WebCodecs error. If `captureStream()` shows audio but `AudioEncoder` / `MediaStreamTrackProcessor` is missing, we throw and ffmpeg.wasm encodes **video + audio** on CPU. That matches “CPU busy, GPU idle.”
2. **Even a good WebCodecs run is CPU-heavy here.** Hidden `<video>` + `requestVideoFrameCallback` + canvas scale + `VideoFrame`. Hardware encode, if it happens, shows on the **Video Encode** engine, not GPU 3D. Batch was **uncapped**; 4K through the canvas pump pegs CPU. Cap **1920** cuts that copy a lot.
3. `prefer-hardware` is a hint. Chrome can still pick a software `VideoEncoder`.

## 1. Video path

### Today

Probe AVC → play element → if any audio track and AAC/MSTProcessor missing, **throw** → empty `catch` → ffmpeg `libx264 ultrafast`.

### Target (in order)

1. Encode **video** on WebCodecs whenever `VideoEncoder` works. Do not throw because audio capture failed.
2. **Audio ladder** (only if the source has an audio track):
   1. `captureStream` + `MediaStreamTrackProcessor` + `AudioEncoder` AAC → mux.
   2. Else `AudioContext.decodeAudioData` on the original blob → `AudioEncoder` AAC → mux (no MSTProcessor).
   3. Else ffmpeg **audio-only remux**: WebCodecs MP4 as video, original as second input, `-map 0:v -c:v copy -map 1:a -c:a aac` (or `-c:a copy` if the source is already AAC). Video stays hardware; ffmpeg only touches audio.
   4. If the file **has audio** and every audio path failed → **skip** (`CompressionSkippedError` or a dedicated skip with reason `audio-unavailable`). Count as skipped, message like `2 skipped (could not keep audio)`. Do not upload.
   5. If the file **has no audio**, mux video-only. That is not a skip.
3. Full ffmpeg libx264 only when **VideoEncoder** is missing, config unsupported, or video encode throws. Surface `ffmpeg (CPU)`. No empty `catch`.

`CompressMediaResult` gains `encoder: "webcodecs" | "ffmpeg"` and `audio: "aac" | "ffmpeg-remux" | "none"` (`none` = source had no track). UI: `Hardware H.264` / `ffmpeg (CPU)`.

Log file id, encoder, elapsed ms only.

**1920 cap:** `compressAndUploadMedia` / batch job pass `maxLongEdge: 1920`. Viewer preview keeps `VIDEO_COMPRESS_PREVIEW_MAX_LONG_EDGE` (1280). GIF scale unchanged (320/480).

## 2. Filters — independent, no sort

Gallery `TagFilterBar` cannot be mounted as-is: it writes the **global** `tagFilter`, plus stamp, shuffle, and Options **sort**.

### UI on Compress

Reuse gallery **filter** controls, wired to `useTagFilterDraft` (same pattern as album editor):

- `TagClausePicker` (include / exclude / only)
- Query builder / Options **Filter** half: tagged, favorites, photos/videos, cropped

**Omit:** Randomise, Stamp, Selection mode (grid is already tap-to-select), Options Sort (Updated at, fit, size, nearness, kit likeness), “Tag matching…”.

`TagQueryBuilderPanel` and `TagScopeFilterDropdown` currently read `useTagStore`. Compress will pass `filter` + actions as props (or a `filterOnly` mode that hides Sort). Gallery store stays untouched.

Counts in those dropdowns: compute from **library files** (same as gallery) or from compress candidates? **Library**, so “12 videos” means the library, then skip-compressed / min-size still shrink the grid. Filter then floor, not the other way around.

### Pipeline (unchanged order after filter)

`allFiles` → independent `filterFilesByTags` → skip compressed (unless toggled) → min size → **always** `sortCompressCandidatesBySize` (largest first).

Session-only draft; reset when leaving Compress. Selection already drops ids that leave the candidate set.

## 3. Progress at every stage

Per file:

```
stage: download | compress | upload | skip | done | error
fileLabel
index / total
ratio?: 0–1
encoder?: webcodecs | ffmpeg
```

**Download:** `loadMediaBytesForEdit` already has `{ loaded, total }`. Wire it. Cached video may snap to 100%.

**Compress:**

- Video WebCodecs: frame-time ratio.
- Video/GIF ffmpeg: ffmpeg ratio.
- Stills: no true AVIF %. Labels `decoding` / `encoding`, indeterminate bar, jump to 100% only when the worker returns.

**Upload (real %):** `putFile` is `fetch(PUT)` of the whole body — **fetch does not report upload progress**. Add an optional `onProgress` via `XMLHttpRequest.upload.onprogress` (or `xhr` equivalent) on the **file object PUT** (the large blob). Thumbnail PUT is tiny.

Weighting for the upload stage (0–1 the UI shows):

| Slice | Approx |
|---|---|
| Thumbnail extract + encrypt | 0–15% (no byte signal; tick at start/end of each step) |
| File PUT | 15–90% (XHR `loaded/total`) |
| Thumb PUT + `postEnteFile` | 90–100% |

Thread `onProgress` through `uploadCompressedMedia` → `EnteCore.uploadCompressedMedia` → `enqueueDerivedReplace` / `compressAndUploadMedia`. Batch and viewer share it.

Do not log ciphertext sizes beyond the ratio.

**Batch line:** `3 / 12 · holiday.mp4 · downloading 62%` → `compressing 41%` → `uploading 70%`.

Extend `useCompressJobStore` with stage + label. `runCompressJob` reports **during** each file, not only after.

## 4. Footer + drop CRF

- Remove Settings gear, CRF slider, CRF copy from Manage, viewer, batch review.
- Keep Skip compressed + Minimum file size on Manage.
- Viewer: no Settings dialog; use persisted min-size.
- Selection footer: `4 photos · 2 videos · 86.3 MB`. GIFs in the photo count. Known `fileByteSize` sum; if any selected size is 0, `86.3 MB + unknown`.
- During a job, footer is the stage line, not the mix.
- `videoCrf` is the constant `DEFAULT_VIDEO_CRF`. Batch sheet: min-size + “skip if it would not shrink 2%”; no CRF sentence.

## 5. Size overlay — compress grid only

- `showFileSize` on `ThumbnailGrid` / `ThumbnailCell`. Only Manage Compress sets it.
- Bottom-left, `bg-black/60`, `1.2 MB` / `340 KB`. Omit if size 0.
- Play stays bottom-right; compressed check top-left; selected check bottom-right.
- `thumbnailCellPropsAreEqual` must include the prop and `file.info.fileSize`.

## Implementation map

| Change | Where |
|---|---|
| Encoder + audio ladder; skip if audio cannot be kept | `webcodecs-h264.ts`, `compress-media.ts` |
| ffmpeg audio remux | `compress-media.ts` / `ffmpeg` |
| Batch `maxLongEdge: 1920` | `compressAndUploadMedia` / `compress-job` |
| Independent filter, no sort | `ManageCompressPanel` + draft + `filterFilesByTags`; prop-inject query builder / Filter half |
| Stage progress | `compress-job.ts`, job store, both UIs, `load-media-bytes` |
| Upload XHR % | `remote.ts` `putFile`, `upload-compressed-media.ts`, core + library store |
| Footer + drop CRF | `ManageCompressPanel`, `CompressionPanel`, `BatchCompressPreviewSheet` |
| Size chip | `ThumbnailCell` + `ThumbnailGrid`, compress panel only |

Crop/rotate and the video editor stay out of this pass except they inherit types if they call `compressMediaBytes`.

Tests: audio-present + AAC-unavailable does not call full libx264; skip when remux fails; no-audio video-only succeeds; job stages; filter then min-size then size-desc; `putFile` progress callback; size label on cell. WebCodecs itself stays browser-only.

## Agentic test

No Cursor browser MCP. After code:

1. `npm run dev` in `mobileapp/`
2. Headed Playwright → `/dev-login`
3. Gallery filter changed, Compress still shows its own filter; order is largest first; no sort/shuffle/stamp on Compress
4. Size chips; footer mix + bytes; no CRF UI
5. Still: download % → compressing (indeterminate) → upload %
6. Video: encoder label; 1920 path; skip (not silent replace) if audio cannot be kept
7. Force no VideoEncoder: UI says ffmpeg
8. Lint / tests / build / `APP_VERSION` bump

Playwright will not prove GPU. Headed Chrome + Task Manager **Video Encode** (not 3D) is the hardware check.

## Gaps closed this pass (no extra questions)

- Filter chrome: filter yes, **sort never** — always size desc.
- Audio last resort: skip, do not mute.
- 1920 batch cap.
- Upload % via XHR on PUT (fetch cannot).
- GIFs counted as photos.

If that matches what you want, say go and I’ll implement and drive `/dev-login` locally.
