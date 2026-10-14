# Kit nearness: MobileCLIP-S2 research conclusions

Anonymised corpus only (`t_` tag ids, `k_` kit ids). No embeddings, hashes or names are recorded here. The corpus export is private and not in git.

**Scripts.** The research runners (passes 1 to 6, kit presence, exact-membership, ONLY retune) were deleted in the simplification cleanup. They can be found at commit `81946e8e48` under `mobileapp/scripts/kit-nearness-*.ts` and `kit-presence-s2.ts`. Run logs from them were trimmed from this file; the findings, numbers and recommendations are kept.

**Corpora.**
- Passes 1 to 5: v3, `Xenova/mobileclip_s2`, 5723 CLIP photos, 9 tags, 25 saved kits, 35 AND eval kits.
- Pass 6: v4, 5882 photos with `thirds-v1` tiles (108,640 tile rows). Tag ids were re-randomised (the 11% tag is `t_0001`, the 64% tag is `t_0007`).

## Current state

- Passes 1 to 3b and pass 5 are in production (`0.3.119` default genome, `0.3.120` pass-5 margins).
- Pass 4 was a stepping stone; pass 5 supersedes its scorer. Pass 4's protocol still applies.
- Pass 6 (tile embeddings) is concluded and negative. Nothing from it should ship.
- Kit presence (the "kit likeness" list) is a separate question: independent per-kit counts replaced the old winner-takes-all share in `0.3.122`.
- The nested-kit "dropdown drowning" was fixed for the dropdown only in `0.3.129` (exact-set, theta 0.4). Gallery ranking stays AND.

## Protocol (passes 1 to 5)

- Membership is AND: a positive has every kit tag.
- Easy negatives share no kit tags. Hard negatives share some but not all tags (sibling kits); this is the real job. Arity-1 kits have no hard negatives and are dropped from hard evaluation.
- Pass 4 onward uses a global 60/40 photo split. An evaluated photo is absent from every selected, rival, hard-negative and tag prototype. dHash near-duplicate groups (Hamming <= 6) stay on one side. Development seed 42; confirmation seeds 99, 123, 2024, 7; reserved 60/20/20 split seed 314159 where validation picks the cell and the test partition is reported once.
- Eval kits are saved presets plus the 24 most frequent generated combinations at arity 1, 2 and 3, deduplicated at member-set Jaccard >= 0.85. Minimum fold sizes: 8 training positives, 5 test positives, 16 hard negatives, 24 easy negatives.
- Metrics: hard AUC (full member beats a partial-tag sibling), easy AUC (vs no-shared-tag photos), hard AP, full AP, and hard@12 / full@12 (positive fraction in the first min(12, positives) results, a first-screen metric). Confidence intervals resample saved kits 4,000 times; repeated splits are averaged per kit first.

## Fingerprints and the default genome (passes 1 to 3b)

CLIP-S2 mean centroid is the prototype. Almost every clever variant lost or tied (hard AUC vs centroid 65.2%, no rivals):

| Idea | Result |
| --- | --- |
| Diagonal Mahalanobis | +0.7pp (only real fingerprint lift; hurts once rivals are on) |
| k-means k=2/3, max(centroid, nearest seed) | +0.1pp |
| dHash bonus, kNN, trimmed/core | 0 or worse |
| Densest medoids (old default) | -5.6pp hard, -8pp easy (-12pp easy even with lambda=8) |

dHash and colour do not help S2 membership; do not mix them into CLIP ranking.

**Rivals matter most.** Easy AUC is already 82 to 91%; the gain is almost entirely exclusivity against overlapping kits. A rival's weight is delta/(delta+tau), so smaller tau makes similar rivals compete. Jaccard-4 rivals (used in the early passes) were the wrong proxy and understated exclusivity by about 7pp hard. The app uses every other saved kit (`savedAll`, about 18 rivals); `savedAll` is roughly equal to `allKits`. CLIP-nearest-4 and tag-subset rivals are worse than Jaccard-4; AND-combo rivals add nothing beyond `savedAll`. More rivals help until about all saved kits.

**lambda and tau on production rivals (`savedAll`, hard AUC, all eval kits):**

| lambda | tau 0.02 | tau 0.06 | tau 0.12 |
| --- | --- | --- | --- |
| 0 | 65.2 | 65.2 | 65.2 |
| 4 | 78.5 | 76.6 | 74.5 |
| 8 | 80.9 | 79.6 | 77.9 |
| 16 | 82.1 | 81.5 | 80.4 |
| 24 | 82.3 | 82.1 | 81.4 |

Easy AUC is flat at about 93% from lambda=8 upward, so high lambda does not over-penalise unrelated photos. lambda=16 tau=0.02 is the start of the plateau: +2.3pp hard over lambda=8 tau=0.06 on 5 seeds (min 80.7 vs 78.7), confirmed on fold B (saved kits 84.5% hard). lambda=24 adds only +0.3pp.

**Shipped default (`0.3.119`):** `useCentroid: 1, rivalLambda: 16, rivalTau: 0.02`, rivals = all other saved presets, gene cap 24. Saved presets, fold B: old medoid lambda=4 about 67% hard AUC, new default 84.5%.

**Per-kit tuner.** Against lambda=16 tau=0.02 the remaining grid lift is +0.42pp mean, one kit >= 2pp, none hurt. The minutes-long GA was searching a plateau. Keep a small centroid lambda x tau grid (15 cells, >= 2pp to persist, no medoids); do not bring the GA back. Medoid picks were the only ones that overfit and hurt.

**Other results:**
- A two-stage centroid shortlist is a quality loss (hard 65.9 to 70.8 vs 72.9 full); the rival penalty must apply to the whole ranking.
- A seed cap of 40 is enough (400 gains 0.2pp).
- Mix-picked and hard-picked grids agree once the default is high-lambda.
- Not worth doing: tau < 0.02, lambda > 24, a multi-item menu, CLIP-NN rivals, two-stage rerank. The in-app tuner fold samples random non-members, so it is noisier than this protocol if a kit ever wants a different lambda.

## Pass 4: leakage-free hard-negative and per-tag margins

Under the stricter leak-free protocol production is still 84.4 to 84.5% hard AUC, so the lambda=16 gain was not leakage. The better scoring family adds two terms to the production score:

- `m_hard`: selected-centroid similarity minus similarity to the centroid of training photos with some but not all kit tags.
- `m_tag`: the minimum over kit tags of (similarity to the tag's positive centroid minus similarity to its negative centroid).

With balanced global weights 8/8 (picked by validation), the untouched reserved test partition, saved kits: hard AUC 84.4 to 88.3 (+3.85pp, CI +2.71 to +5.04), hard AP 45.7 to 54.9, hard first-screen 58.3 to 71.9, full AP 43.8 to 53.9, easy AUC 96.8 to 97.7; 12 kits improved by >= 2pp, none fell by 2pp. `m_hard` supplies most of the AUC gain, `m_tag` most of the first-screen gain. Aggressive 24 to 32 weights gave about +0.5pp AUC but worse first-screen.

Did not justify implementation: all positive seeds instead of the first 150 (+0.08pp), symmetric rival margins (about +0.1pp), soft rivals (about +0.7pp, CI crosses zero), more lambda/tau tuning, medoids/dHash/colour/kNN/trimmed centroids. Per-kit weight tuning was +0.26pp hard AUC (CI crosses zero) but +2.7 to 2.9pp first-screen. A duplicate threshold of 10 chains most of the library into a few components and unbalances the split, so it is a direction check only.

Open items from pass 4: a second independent library/export (all CIs cover variation across kits in one taxonomy, not cross-library generalisation), an untagged-inclusive corpus (corpus v3 exports tagged photos only, so `fullAP` is a tagged-library metric), and phone latency/memory. Model swaps need a new private rescan.

## Pass 5: whitened hard margin and learned per-tag directions (shipped, `0.3.120`)

Same protocol as pass 4. Confirmation seeds, saved kits (18), mean of four seeds:

| scorer | hard AUC | hard AP | hard first-screen | full AP | easy AUC |
| --- | --- | --- | --- | --- | --- |
| production (0.3.119) | 84.5 | 41.3 | 56.6 | 39.4 | 95.4 |
| pass 4 (8/8 raw margins) | 88.0 | 50.1 | 70.4 | 49.0 | 96.6 |
| **pass 5** (`l2=0.01 h1.5 t4`) | **93.0** | **61.1** | **76.4** | **60.7** | **98.1** |

All 28 arity >= 2 kits: hard AUC 82.5 to 87.0 to 92.6; hard first-screen 61.6 to 74.5 to 80.8. Paired vs pass 4 (saved kits): hard AUC +4.93pp (CI +3.67 to +6.26), 15/18 kits >= +2pp, none <= -2pp; first-screen +6.02pp (CI +2.78 to +9.49). Reserved test partition: 88.3 to 92.8 (+4.50pp). Versus production on that partition: +8.35pp hard AUC (CI +5.72 to +10.96), +15.6pp first-screen (CI +8.85 to +22.40). Stress runs (duplicate threshold 2 and 10) agree in direction.

**The scorer** (higher is better; all vectors and centroids L2-normalised). `s_production` is the centroid score minus 16 times the weighted rival steal; `c_hard` is the centroid of training photos with some but not all kit tags. Built once from the training population X (embedded, tagged stills):

```text
mu  = mean of X
S   = covariance of X (512x512, mean-centred)
S_a = S + (a * trace(S) / 512) * I          a = 1
L   = cholesky(S_a)

w_hard    = S_a^-1 (c_selected - c_hard)    two triangular solves with L
m_hard(x) = x . w_hard

per kit tag t: class-balanced logistic regression in whitened coordinates
  z_i = L^-1 (x_i - mu); minimise mean_i omega_i * logloss(y_i, z_i . w + b) + 0.5 * lambda * |w|^2
  lambda = 0.01, Adam lr 0.1, 100 iterations from zero, deterministic row order
  w_t = L^-T w, b_t = b - mu . w_t
m_tag(x) = min over t in K of (x . w_t + b_t)

s_pass5 = s_production / sigma_prod + 1.5 * m_hard / sigma_hard + 4 * m_tag / sigma_tag
```

`sigma_*` are the standard deviations of each term over the training population (keeps weights unit-free).

The weight surface is a plateau: hard weight 0.5 to 2 and tag weight 2 to 6 all sit within 92.4 to 93.1 dev hard AUC, and lambda 0.001 to 0.03 confirms within 0.2pp. `h1 t3` is the plateau centre. Do not tune these.

Why it works: solving against the shrunk covariance rescales the raw centroid difference to the discriminative directions (+2.8pp alone). The L2 penalty in whitened space is a scale-free regulariser; the same model with raw-space L2 is 1.2pp worse. `min` over tags beats summing log-odds (the sum is about 2pp AUC and 8pp first-screen worse).

**Ablations** (confirmation seeds, saved kits):

| variant | hard AUC | first-screen |
| --- | --- | --- |
| full pass 5 | 93.0 | 76.4 |
| drop hard term | 91.8 | 74.0 |
| drop rival steal (plain centroid) | 92.2 | 76.2 |
| drop centroid and steal (LR + hard only) | 93.0 | 75.2 |
| LR trained on 2000-row subsample | 92.6 | 75.6 |
| per-kit weight tuning | 93.1 | 77.1 (+0.15pp, CI crosses zero: no tuner) |

**Tested and not worth repeating:** shrinkage alpha in {0.3, 1, 3} (flat within 0.3pp); balanced hard-negative prototype per missing-tag pattern (worse, 88.6 vs 90.9); whitened rival steal or kit-vs-rest direction (<= 0.1pp); learned kit-vs-hard logistic instead of the LDA direction (90.5 vs 90.9); LR lambda 1e-4 (1pp worse, slow); covariance from a 500 to 2000-row sample (AUC within 0.6pp, first-screen -2 to -3pp); fixed un-normalised weights (90.3 vs 90.9); per-kit weight tuning.

**Production recipe and cost** (desktop Node, 3433 rows): covariance 0.46 s, Cholesky 25 ms, whitening 0.42 s, one logistic model about 0.4 s per tag; per-candidate scoring adds `1 + |K|` dot products.
1. Build mu, S_a, L once per session from eligible embedded tagged stills (stills, not archived, not videos). In memory only; never persist.
2. Train logistic models lazily, only for the tags of the selected kit, in a web worker, with training rows capped at about 3000 (fixed-seed uniform sample: -0.4pp AUC / -0.8pp first-screen). The objective is convex, so a single run from zero reaches the same optimum as the research runner's warm-start ladder.
3. Per frozen nearness snapshot: `c_selected`, `c_hard`, `w_hard`, one pass over candidates for the three raw terms, one pass over training rows for sigma, then score and sort with file id as tie-break.

**Fallbacks** keep the production order: no matched kit, exclusivity off, fewer than two kit tags (arity 1 deliberately uses production; the arity-1 variant is well-defined but unmeasured), fewer than about 8 complete members / partial members / tag positives / tag negatives in the sample, or a worker failure. A tagged candidate contributes to the models that score it in the live app; do not claim that as measured lift.

**Implementation (`0.3.120`).** `src/lib/kit-nearness-margins.ts` (packed-array maths: `buildKitWhitening`, `trainTagLogOddsModel`, `rankByKitMargins`), `src/workers/kit-nearness-margins.worker.ts` (caches whitening per training-id set and each tag model per label vector; terminated on logout), `src/lib/kit-nearness-margins-job.ts` (main thread: training population, fixed-seed cap 3000, production score from `kitEmbeddingDistanceCompetitive`). The gallery shows the synchronous production order first and swaps in the worker order when it lands. Differences from the research runner (inside seed noise): `c_selected` is the centroid of all sampled complete members, a single run from zero, ties by file id.

**Parity check** (shipped functions as a scorer on the same folds, hard AUC / hard@12):

| split | production | pass 4 | research pick | shipped code |
| --- | --- | --- | --- | --- |
| development (seed 42) | 84.4 / 56.9 | 88.1 / 68.5 | 93.0 / 77.3 | 93.0 / 78.2 |
| confirmation x4 seeds | 84.5 / 56.6 | 88.0 / 70.4 | 93.0 / 76.4 | 93.0 / 75.5 |
| reserved test | 84.4 / 58.3 | 88.3 / 71.9 | 93.3 / 75.0 | 93.3 / 74.5 |

Shipped-code timing on desktop Node: `buildKitWhitening` 0.94 s (once per session), 0.34 s per tag model.

**Remaining research:** a second library/export; an untagged-inclusive corpus; phone timing (whitening at the 3000-row cap expected 3 to 5 s once per session, one tag model 1 to 1.5 s; lower `KIT_MARGIN_TRAINING_ROW_CAP` if too slow). Not worth more digging on this corpus: weights, alpha, lambda, solver variants, per-kit tuning, hard-negative reweighting, tag aggregation. The remaining 7pp gap to a perfect hard AUC needs a different model or image bytes.

## Pass 6: tile embeddings (concluded, negative)

**Why it was tried.** Per-tag detectability with the pass-5 detectors: seven tags at 94 to 97.5% test AUC, two well below: `t_0005` (11%, small and inconsistent) 87.2% and `t_0004` (64%, tiny in frame) 91.2% (corpus 2 ids). Hard negatives that beat true members are the ones missing one of those two tags. Suspected mechanisms: pooling/caption bias (a 3%-of-frame item contributes about 3% of the signal) and the model's centre crop (shortest edge to 256, centre-crop 256x256, so edge items are absent) on thumbnails of <= 720 px.

**Design.** Square tiles, side = shortest edge / 3, covering the whole frame (layout `thirds-v1`; 3:2 gives 15 tiles, 4:3 gives 12, square 9, 16:9 18). Intended scorer: per tag, max over {global, tiles} of log-odds; kit score still min over tags. Pre-registered gates: the weak tag moves 87 to low 90s and the `t_0004` kits move by several points with CIs clear of zero; still under 90 means not a spatial problem.

**Pilot scan.** 5,882 tagged photos in about 13 min on a desktop WebGPU (about 135 ms/photo). A geometry flaw was found: `floor(shortEdge/3)` made the tile slightly smaller than a third, so a fourth near-duplicate column appeared whenever the short edge was not divisible by 3 (18.5 tiles/photo instead of about 14, so the true cost of exact thirds is about 25% lower). Harmless for max/mean pooling; fix with `ceil` and a layout id bump if ever revived.

**Per-tag detector AUC, development test photos (2,353)** for the key tags (G = shipped global detector, T1w = multiple-instance logistic on tiles, GM = global concatenated with the tile mean):

| tag | n | G | T0max (G on tiles) | T1w | GM |
| --- | --- | --- | --- | --- | --- |
| `t_0001` (11%, inconsistent) | 222 | 86.8 | 64.8 | 88.2 | 87.8 |
| `t_0007` (62%, tiny) | 1400 | 91.6 | 75.9 | 85.1 | 92.2 |
| others (7 tags) | 87 to 1578 | 93.3 to 98.0 | 72.5 to 87.0 | 87.9 to 96.1 | 94.0 to 98.1 |

The gates failed: the inconsistent tag moved 86.8 to 88.2 at best, the tiny tag 91.6 to 92.2. For `t_0007` the tile detectors are worse than global by 6 to 7pp (the global detector uses scene context the crop throws away). The global detector applied per tile collapses to 65 to 87 (a distribution shift). Multiple-instance training under-fits even the training set. The only variant at or above G on most tags is the global-plus-tile-mean concatenation (7/9 tags up by +0.1 to +1.0), a complementary view, not a better one; corner tiles only lose most of that.

**Kit level, saved kits, confirmation mean of four seeds** (paired deltas vs shipped `G h1.5 t4`, hard AUC 92.7 / hard AP 60.4 / first-screen 77.1):

| scorer | hard AUC | delta hard AUC (CI) | delta first-screen (CI) |
| --- | --- | --- | --- |
| `GM h1.5 t4` | 92.7 | +0.04 (-0.27, +0.31) | +0.93 (-0.93, +3.13) |
| `T1max` / `T1w` | 90.4 / 90.0 | -2.21 / -2.65 | -4.76 / -4.28 |
| `dual T1w +1` (shipped plus a tile term) | 93.0 | +0.39 (+0.14, +0.65) | +1.39 (-0.46, +3.01) |

Reserved test: `dual T1max +2` +0.68pp hard AUC (CI +0.29 to +1.04), first-screen +2.81 (CI crosses zero).

**Verdict: do not ship.** Tiles at 1/3 of the shortest edge from <= 720 px thumbnails do not recover small-in-frame tags. They add a weak generic second view worth +0.4 to 0.7pp hard AUC and +1.5 to 2pp hard AP at 13 to 18x the scan cost. The only variant with a significant kit-level gain needs every tile vector stored (37 KB/photo, about 1 GB for a 30k library) and in-browser multiple-instance training; the storage-friendly `GM` variant is +0.04pp. The 7pp gap is not a spatial-pooling problem at this input resolution. The pilot code (tile layout, `embed-tiles`, `tileEmbeddings` store, scan job, corpus v4 sidecar, Manage -> Developer controls) is dev-only and off the ranking path; remove it in a housekeeping batch.

**Not tested:** full-resolution tiles (needs the original file; not a PWA-on-mobile workload); 1/2-scale or 2x2 / 3x3 grids (between a null result and +0.5pp at 4 to 9x cost); test-time augmentation over 2 to 3 shifted full-frame crops (ceiling is `GM`'s +0.04 to +0.6pp); a different image model (the only route left for the two weak tags, a different project).

## Kit presence: the "kit likeness" list (shipped, `0.3.122`)

Different question from ranking: given the photos in view, which kits are present and how much. The old estimator was winner-takes-all (each embedded photo counts for the kit whose nearest medoid is closest). Truth = fraction of the view's photos carrying all of a kit's tags. Views came from the test side of a 60/40 dup-safe split: whole test set, tag-filtered, kit-filtered, contiguous 60-photo windows, random 60-photo samples; 24 saved kits (>= 20 members), 5 seeds.

Prevalence results, mean over 5 seeds (MAE in pp; rho = Spearman of estimated vs true kit order; top-1 = estimated top kit within 10% of true top; ghosts = kits truly < 2% shown >= 10% per view; missed = kits truly >= 30% shown < 10% per view):

| estimator | MAE | rho | top-1 | ghosts | missed |
| --- | --- | --- | --- | --- | --- |
| production (nearest medoid) | 12.5 | 0.14 | 31.8 | 0.48 | 1.83 |
| softmax tau=0.05 | 11.8 | 0.46 | 59.4 | 0.00 | 2.99 |
| distance logistic | 8.1 | 0.72 | 80.9 | 1.25 | 0.52 |
| tag product (prior-corrected) | 5.5 | 0.84 | 94.6 | 0.74 | 0.06 |
| tag min (prior-corrected) | 5.8 | 0.84 | 93.8 | 1.45 | 0.01 |
| tag product @0.5 (count) | 5.7 | 0.82 | 94.7 | 0.15 | 0.15 |
| kit logistic (natural) | 5.3 | 0.84 | 94.2 | 0.90 | 0.04 |
| kit logistic @0.5 | 5.5 | 0.81 | 93.6 | 0.19 | 0.17 |

Worked example (largest tag-filtered view, 1,952 photos): the production estimator read 28.9 / 11.3 / 0.0 / 0.0 for kits whose true prevalence was 80.8 / 46.2 / 17.6 / 15.8, while the tag product read 76.4 / 45.5 / 15.3 / 17.7.

Reading:
- The semantics are the problem, not the softness. Any score that sums to 1 over kits must split a photo that belongs to `[A,B]` and `[A,B,C]`, so nested kits can never both read high. Softmax barely moves the numbers and misses more kits.
- Independent per-kit prevalence from the pass-5 per-tag detectors is accurate: MAE 5.5pp, top kit right 95% of the time. The product over a kit's tags nests correctly by construction. A per-kit logistic is equivalent (5.3pp) but needs one model per kit instead of one per tag.
- Hardening to a count (p >= 0.5) trades a little MAE on big kits for five times fewer ghosts (0.15 vs 0.74 per view) and gives the display a literal meaning ("N of M photos fit").
- Kit-filtered views are the hardest for every estimator (major MAE about 37pp), but in the app those are tag filters where the tags are known. The 1-D distance logistic is a cheap 8.1pp fallback, not worth a second code path.

**Shipped (`0.3.122`).** A file fits kit k when the product over k's tags of its tag probability is >= 0.5 (`KIT_PRESENCE_FIT_THRESHOLD`); a tag the file carries has probability 1, a missing tag uses the per-tag logistic sigma(log-odds + log(n+/n-)); files without an embedding fit only through known tags. The list shows `Kit name (count)`, a count rather than a percentage, sorted by count with ties to the kit with more tags. Code: `tagPresenceProbabilities` and `countKitPresence` in `kit-nearness-margins.ts`; a `presence` request in the margins worker; `countKitPresenceInWorker`; `TagFilterBar` posts the shown files on every view change. Tags with fewer than 8 positives or negatives are dropped and their kits show no count. The known-tag override was not measured (all corpus photos are tagged); the table is the all-unknown lower bound.

## Exact-tag (ONLY) membership vs AND

Membership today is AND (every kit tag, extras allowed). Exact means the photo's tag set is the kit's tag set. The AND baseline on this run matched the published numbers (ranking hard AUC 92.9 vs 93.0; presence MAE 5.7pp, rho 0.82, top-1 94.7, ghosts 0.15).

Extras share: high-arity kits are almost exact (5-tag kit 1.8% extras); nested 2 to 3 tag kits are mostly supersets (93.5%, 91.3%, 89%). AND and exact centroids are nearly identical (cosine delta 0.000 to 0.04) because extras still contain the kit tags.

Gallery ranking (saved arity >= 2, delta vs AND/AND, hard AUC 92.9 / first-screen 76.1): exact centroid with extras out of `c_hard` -0.3pp; extras in `c_hard` -0.6pp; AND seeds scored against exact truth 89.3 (first-screen 41.9); exact-hard / exact 92.1. Purer seeds do not help the AND job. Treating extras as negatives cannot work well because they look the same as exact members; first-screen and hard AP collapse even when AUC is recovered.

The presence estimator is AND-like by construction: pointed at exact prevalence it ghosts nested parents (ghosts 3.33, rho 0.29). A hard predicted-set match calibrates the count (MAE 2.2pp) but ranked kits worse than the AND list. That run used AND-tuned genes, which is the wrong experiment; see the retune below.

## ONLY retune: drowning, presence, ranking

**The drowning is by construction, not a bad lambda.** The dropdown sorts by fit count, then more tags, then name. Under AND a parent kit `{A}` counts every photo of child `{A,B}`, so the parent always outranks the child: 59/59 nested pairs on the presence corpus (parent AND count >= child). Spearman of AND vs ONLY list order is only 0.54. Examples (AND rank to ONLY rank): a 2-tag kit 1116 AND / 39 exact, rank 3 to 19 (96.5% extras); a 3-tag kit 583 / 22, rank 8 to 23; a 3-tag kit 992 / 64, rank 4 to 17. High-arity almost-exact kits rise (7 to 3, 9 to 4, 15 to 5). Under ONLY the child outranks the parent in 23/59 pairs. On tagged photos the fix is `countFilesMatchingKitExact` (already used in tag-picker ONLY mode): a known extra tag means the photo does not fit.

**Presence estimators vs ONLY truth** (5 seeds; parentWins = nested parent estimated above child; child@5 = recall of arity >= 2 kits truly in the exact top 5):

| estimator | MAE | rho | child@5 | parentWins | top-1 |
| --- | --- | --- | --- | --- | --- |
| AND product @0.5 (shipped, soft) | 8.5 | 0.35 | 41.3 | 100 | 66.5 |
| **exact-set @0.4** | 2.0 | 0.64 | 83.0 | 38.9 | 56.2 |
| exclusive-hard (in 0.5, out 0.4) | 2.0 | 0.64 | 80.1 | 38.6 | 65.8 |
| kit logistic exact (natural) | 2.6 | 0.65 | 81.2 | 56.3 | 89.3 |
| kit logistic exact @0.5 | 2.2 | 0.61 | 75.6 | 29.0 | 89.7 |

Predicted tag-set equality roughly doubles specific-kit top-5 recall. Kit-level logistic gives the best top-1 but needs one model per kit.

**Ranking GA / grid (ONLY task).** New terms: `m_extra = x . S^-1 (c_exact - c_extras)` and `m_excl = -max over tags not in the kit of log-odds_t(x)`. Fitness = first-screen mix (0.4 AUC + 0.2 AP + 0.4 hard@12). 648-cell grid then GA (pop 28 x 20 gens x 2 restarts), confirmed on 4 seeds:

| genes | hard AUC | exclusive AUC | first-screen | delta @12 vs AND-genes |
| --- | --- | --- | --- | --- |
| shipped lambda16 tau0.02 h1.5 t4 | 91.3 | 67.7 | 49.1 | n/a |
| excl-tag x4, rest shipped | 93.1 | 80.0 | 52.4 | +3.2pp |
| grid lambda8 tau0.06 hP1.5 hE0 t4 x2 | 93.0 | 76.4 | 54.2 | +5.0pp [3.4, 6.7] |
| GA lambda7.5 tau0.07 hP1.5 hE0 t3.6 x1.8 | 93.1 | 76.6 | 54.7 | +5.5pp [4.2, 6.9] |

GA is about equal to grid. `hE=0` in both winners: penalising extra tags beats stuffing extras into a second centroid. CLIP can separate exact from extras better with the tag term, but first-screen stays about 55 vs AND's about 76: thumbnail S2 cannot put exact members on screen as reliably as AND members.

**If shipping ONLY** (proposed default: `useCentroid 1, rivalLambda 8, rivalTau 0.06, hardWeight 1.5, tagWeight 4, exclTagWeight 2`):
1. Dropdown / kit list: for known tags, a file fits kit k only when its user-tag set equals k's tags (this is the whole fix for tagged photos). Untagged stills: predicted tag-set equals the kit (theta 0.4) or exclusive-hard; do not keep the AND product. **Shipped in `0.3.129`.**
2. Gallery ranking: switch seeds to exact members, `c_hard` = partial-tag photos (not extras), add `exclTagWeight=2`, lambda 8, tau 0.06. Expect first-screen about 55%, not 76. **Not shipped**: AND is wrong for nested kits as a list, but ONLY ranking is a weaker retrieval task, and the owner has to decide whether it is worth the hit.
3. Do not reuse AND genes. Do not bring back a long in-app GA; the 6-gene grid already matches it.
