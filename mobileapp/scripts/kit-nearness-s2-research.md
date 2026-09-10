# Kit nearness — MobileCLIP-S2 research log

Living notes. Anonymised corpus only (`t_` / `k_` ids). No embeddings/hashes/names pasted.

**Corpus (passes 1–5):** `C:/Users/Elliot/Downloads/kit-nearness-corpus (2).json` (not in git)  
v3 `Xenova/mobileclip_s2` · 5723 CLIP photos · 9 tags · 25 saved kits · 35 AND eval kits  
**Corpus (pass 6):** `kit-nearness-corpus (3).json` + `kit-nearness-corpus-tiles.f32` (v4,
5882 photos, all with `thirds-v1` tiles, 108,640 tile rows; tag ids re-randomised —
mapping in the pass-6 section)

> **Current state:** Passes 1–3b and **pass 5 are in production** (`0.3.120`,
> see "Implementation" at the end of the pass-5 section). Pass 4 was research
> only and is superseded by pass 5: the same two terms, but the hard-negative
> margin is whitened (shrunk LDA) and the per-tag margin is a learned logistic
> direction. Saved-kit hard AUC 84.5% → 93.0%, first-screen 56.6% → 76.4% on
> confirmation seeds; confirmed on a reserved test split, and the shipped code
> reproduces those numbers on the same folds. Read **Pass 5** at the end of
> this file first. **Pass 6** (tile embeddings for small-in-frame tags) is
> **concluded, negative**: tiles do not recover the two weak tags at
> thumbnail resolution, and the best tile-augmented scorer is worth
> +0.4–0.7pp hard AUC at 13–18× the scan cost. Nothing from it should ship;
> the dev-only pilot stays as is (owner decision). **Kit presence** (the
> "kit likeness" list) is a separate question with a separate section at the
> end: the old winner-takes-all share was wrong by construction for nested
> kits; independent per-kit counts from the pass-5 detectors replaced it in
> `0.3.122`. **Exact-tag / ONLY membership** was first measured with AND-tuned
> genes and looked hopeless for gallery retrieval. A dedicated retune
> (grid + GA, extras as hard negatives, a new “other-tag” exclusivity gene)
> lifts first-screen 49 → 55 and exclusive AUC 68 → 77. The **dropdown
> drowning** complaint is real and separate: AND counts make every parent
> kit outrank its children (59/59 nested pairs); ONLY is the semantics that
> fix it. **Shipped in `0.3.129` for the dropdown only** (exact-set θ=0.4);
> gallery ranking stays AND. See the ONLY-retune section at the end.

## What the first pass actually was

A **single default tweak** (`useCentroid=1`), not a menu, and **no tuner work**. That was too shallow. This file now includes the deep pass.

## Protocol (deep)

- Membership = AND (has every kit tag).
- **Easy negatives:** share *no* kit tags.
- **Hard negatives:** share *some but not all* tags (sibling kits). This is the real job.
- Two folds (seeds 42 / 99). Fingerprints + menu on A; confirm on B.
- Arity-1 kits have no partial-tag hard negs → dropped here (29/35 kits).



## Fingerprints

CLIP-S2 **mean centroid** is the prototype. Almost every clever variant lost or tied:


| Idea                               | hard AUC vs centroid 65.2%              |
| ---------------------------------- | --------------------------------------- |
| Diagonal Mahalanobis               | **+0.7pp** (only real fingerprint lift) |
| k-means k=2/3                      | +0.1pp                                  |
| max(centroid, nearest seed)        | +0.1pp                                  |
| dHash bonus / kNN / trimmed / core | **0 or worse**                          |
| Densest medoids (current default)  | **−5.6pp hard, −8pp easy**              |


dHash/color do not help S2 membership. Do not mix them into CLIP ranking.

Mahalanobis is the only new fingerprint worth a later experiment; not enough to ship yet (new code, +0.7pp).

## Defaults — one genome, not a menu

Stratifying by size × tightness × arity **collapsed**: 6/7 buckets want `centroid λ=8 τ=0.06`. The extra bucket is 1 kit. Held-out menu = held-out λ=8 (78.3%). **No menu to ship.**

Held-out fold B, **hard AUC** (sibling tags):


| Setting                                   | hard AUC  |
| ----------------------------------------- | --------- |
| Current prod (`medoids k=3, λ=4, τ=0.12`) | 68.7%     |
| Centroid + current rivals (`λ=4, τ=0.12`) | 73.6%     |
| Centroid `λ=6, τ=0.06`                    | 77.3%     |
| **Centroid** `λ=8, τ=0.06`                | **78.3%** |


Easy-neg AUC is already ~82–91%; the gain is almost entirely **exclusivity vs overlapping kits**. Smaller τ makes even similar rival kits compete (weight = δ/(δ+τ)). That is legitimate on hard negs: those photos are *not* full members.

Proposed **automatic default** (the whole “menu”):

```
useCentroid: 1
rivalLambda: 8
rivalTau: 0.06
maxMedoids / minSeparation: unused while centroid is on
```

vs current `useCentroid: 0, λ=4, τ=0.12, maxMedoids: 3`.

## Per-kit tuner

Current in-app GA: pop 36 × 70 gens × 2 restarts + polish (~minutes).

A **24-genome grid in ~3s** on fold A, tested on fold B vs centroid λ=4:

- Mean unbiased lift **+4.1pp** hard AUC
- 21/29 kits ≥+2pp, 2 kits **hurt** (−4pp / −6pp) — those picked medoids and overfit
- Oracle ceiling +5.3pp — grid already captures most of this gene set
- **Almost every successful pick was** `cen λ=8 τ=0.06`

So if the default *becomes* λ=8, the tuner’s remaining job on *these genes* is tiny, and searching medoids can make kits worse. Tuner rewrite if we ship the new default:

1. Replace the long GA with a **small grid** (centroid × λ ∈ {0,4,6,8} × τ ∈ {0.06,0.12,0.24} plus optional medoid λ=4).
2. Keep the ≥2pp rule.
3. Do not persist medoid genomes unless they beat centroid λ=8 on a **held-out** split (the two hurts were medoid picks).



## What shipped (0.3.119)

Pass 3 + 3b changed the recommendation. The deep-pass λ=8 number was measured with **Jaccard-4 rivals**. The app already uses **every other saved kit** (~18 rivals). That policy is much better, and with it λ still climbs until ~16 then plateaus.

**Default genome now:**

```
useCentroid: 1
rivalLambda: 16
rivalTau: 0.02
```

Rivals stay “all other saved presets” (already production). Old per-kit tunes are ignored (`tuneVersion: 2`). Tuner is a 15-cell centroid λ×τ grid, ≥2pp to persist. Medoids are not in that grid.

On production rivals, **saved presets, fold B**: old medoid λ=4 was ~67% hard AUC; new default is **84.5%**. Easy AUC went up too (does not collapse).

## Worth knowing (for later you)

- **Do not use Jaccard-4 as a proxy for this app.** It understated exclusivity by ~7pp hard. CLIP-nearest-4 and tag-subset rivals are worse than Jaccard-4. More rivals help until ~all saved kits; AND-combo rivals add nothing beyond savedAll.
- **Centroid, never densest medoids.** Medoids lost even with λ=8 (−12pp easy). k-means-2 ≈ centroid. Mahalanobis + λ **hurts**.
- **λ vs τ:** with savedAll, hard AUC is monotone in λ up to 24. Gains: 0→8 huge, 8→16 ~+2pp, 16→24 ~+0.3pp. τ=0.02 beats 0.06 by ~0.5pp. Easy AUC plateaus ~93.3% from λ=8 upward — high λ is not over-penalizing unrelated photos.
- **Two-stage shortlist is a quality loss.** Rival penalty must apply to the whole ranking (production already does). Seed cap 40 is enough.
- **Per-kit tuner vs λ=16 τ=0.02:** remaining holdout-grid lift **+0.42pp**, 1 kit ≥2pp, 0 hurt. The minutes-long GA was searching a plateau. Keep the grid for the odd kit; don’t bring the GA back.
- **Fitness mix:** mix-picked and hard-picked grids agreed once the default was high-λ. Global GA with every mix hit the gene cap (λ=8, τ=0.02) until we raised it.
- **Not done / probably not worth it:** τ<0.02, λ>24, a multi-item menu, mixing dHash into CLIP, Mahalanobis, CLIP-NN rivals, two-stage rerank, hard-neg sampling inside the in-app tuner fold (it still uses random non-members — if a kit ever wants a different λ, that fold is noisier than this research protocol).



## Status

- [x] Deep fingerprints + hard negatives
- [x] Stratified menu (collapsed to one genome)
- [x] Unbiased tuner vs genes
- [x] Pass 3: stability, rivals, GA, mixes, LOO, saved-only, λ cap, two-stage
- [x] Pass 3b: retune on production `savedAll` rivals
- [x] Implement: centroid λ=16 τ=0.02, gene cap 24, grid tuner, drop old tunes



## Pass 3 results (2026-09-09)

Script: `kit-nearness-s2-pass3.ts`. Same AND kits / hard-neg protocol. Production rival path is **all other saved kits** (`savedAll`); Jaccard-4 is the research proxy used in earlier passes.

Unbiased tuner vs new default on fold B: dense-grid Δ=2.48pp · mix-picked Δ=3.23pp · GA Δ=3.28pp. Heatmap A-best λ=16 τ=0.02 hard=76.1% (B 76.2%). LOO picks: cen12/0.06×29.

```
pass3 kits=35 saved=19
foldsA=29 savedFolds=19

=== 1. Rival policies (centroid λ=8 τ=0.06) ===
  jaccard4   easy=86.9 hard=72.9 mix=79.9 hardTopK=51.6  meanRivals=4.0
  jaccardAll easy=92.1 hard=78.8 mix=85.4 hardTopK=57.5  meanRivals=15.7
  clipnn4    easy=84.0 hard=68.1 mix=76.0 hardTopK=46.4  meanRivals=4.0
  saved4     easy=85.4 hard=70.6 mix=78.0 hardTopK=48.1  meanRivals=4.0
  savedAll   easy=92.9 hard=79.6 mix=86.3 hardTopK=57.6  meanRivals=18.3
  subset     easy=84.5 hard=70.0 mix=77.2 hardTopK=48.1  meanRivals=3.3
  allKits    easy=93.0 hard=79.6 mix=86.3 hardTopK=57.7  meanRivals=28.0
  rival-count sweep (jaccard-ranked, λ=8 τ=0.06)
    k=0   easy=82.5 hard=65.2 mix=73.9 hardTopK=42.9
    k=1   easy=84.0 hard=67.7 mix=75.9 hardTopK=45.0
    k=2   easy=84.6 hard=69.3 mix=77.0 hardTopK=46.6
    k=4   easy=86.9 hard=72.9 mix=79.9 hardTopK=51.6
    k=8   easy=89.2 hard=75.8 mix=82.5 hardTopK=53.9
    k=16  easy=91.6 hard=78.2 mix=84.9 hardTopK=57.2

=== 2. Prototypes × λ=8 (jaccard rivals) ===
  cen λ=0                      easy=82.5 hard=65.2 mix=73.9 hardTopK=42.9
  cen λ=8                      easy=86.9 hard=72.9 mix=79.9 hardTopK=51.6
  med3 λ=8                     easy=67.4 hard=60.7 mix=64.1 hardTopK=37.9
  kmeans2 λ=8                  easy=86.1 hard=72.7 mix=79.4 hardTopK=50.6
  mahal λ=0                    easy=83.3 hard=65.9 mix=74.6 hardTopK=43.1
  mahal + rival-steal          easy=84.7 hard=68.1 mix=76.4 hardTopK=45.7
  cen λ=8 + 0.15 mahal         easy=86.1 hard=70.8 mix=78.4 hardTopK=48.9
  cen λ=8 + 0.4 mahal          easy=85.3 hard=69.2 mix=77.2 hardTopK=47.2

=== 2b. λ × τ heatmap (cen, jaccard4) fold A then confirm B ===
            τ0.02  τ0.04  τ0.06  τ0.08  τ0.12   τ0.2
  λ=0     65.2   65.2   65.2   65.2   65.2   65.2
  λ=2     70.3   69.2   68.6   68.2   67.6   66.9
  λ=4     72.7   71.4   70.6   70.0   69.1   68.1
  λ=6     74.1   72.9   71.9   71.2   70.2   69.1
  λ=8     74.9   73.8   72.9   72.2   71.1   69.9
  λ=10    75.4   74.5   73.6   73.0   71.9   70.5
  λ=12    75.7   75.0   74.2   73.6   72.5   71.1
  λ=16    76.1   75.5   75.0   74.4   73.5   72.0
  best-A: λ=16 τ=0.02 easy=86.8 hard=76.1 mix=81.5 hardTopK=55.1

=== 3. Seed cap (cen λ=8) ===
  cap=40   easy=86.9 hard=73.3 mix=80.1 hardTopK=51.7
  cap=80   easy=86.9 hard=72.9 mix=79.9 hardTopK=51.6
  cap=150  easy=87.2 hard=73.0 mix=80.1 hardTopK=51.6
  cap=400  easy=87.5 hard=73.1 mix=80.3 hardTopK=51.9

=== 4. Saved-preset kits only ===
  n=19
  prod med3 λ=4 τ=0.12   easy=73.6 hard=63.0 mix=68.3 hardTopK=38.6
  cen λ=4 τ=0.12         easy=87.5 hard=70.3 mix=78.9 hardTopK=46.2
  cen λ=8 τ=0.06         easy=90.0 hard=74.8 mix=82.4 hardTopK=52.3
  cen λ=8 τ=0.04         easy=90.4 hard=75.8 mix=83.1 hardTopK=52.6
  cen λ=10 τ=0.06        easy=90.3 hard=75.7 mix=83.0 hardTopK=52.6
  cen λ=12 τ=0.06        easy=90.6 hard=76.3 mix=83.4 hardTopK=52.9
  production-like rivals = all other saved kits
  prod med3 λ=4          easy=80.3 hard=67.2 mix=73.7 hardTopK=42.8
  cen λ=8 τ=0.06         easy=95.0 hard=80.9 mix=88.0 hardTopK=57.1
  cen λ=12 τ=0.06        easy=95.3 hard=82.3 mix=88.8 hardTopK=58.8

=== 5. Multi-seed stability (hard AUC) ===
  seed            prod   cen4/0.12   cen6/0.06   cen8/0.06   cen8/0.04  cen10/0.06  cen12/0.06
  7               64.0        69.1        71.7        72.6        73.4        73.3        73.8
  42              60.6        69.1        71.9        72.9        73.8        73.6        74.2
  99              64.5        69.7        72.5        73.4        74.2        74.0        74.5
  123             61.8        70.4        72.7        73.5        74.2        74.1        74.5
  2024            63.0        69.2        71.9        72.8        73.7        73.5        74.0
  mean            62.8        69.5        72.1        73.1        73.9        73.7        74.2
  min             60.6        69.1        71.7        72.6        73.4        73.3        73.8

=== 6. Leave-one-kit-out default ===
  picks: cen12/0.06×29
  LOO hard mean=74.2%
  always cen8/0.06 hard=72.9%

=== 7. Global GA (gene bounds, fitness=mean hard) ===
  fit=hard  useC=1 λ=8.00 τ=0.020 k=4 sep=0.104  easy=87.4 hard=74.9 mix=81.1 hardTopK=53.1  evals=860
  fit=50/50 mix  useC=1 λ=8.00 τ=0.020 k=4 sep=0.104  easy=87.4 hard=74.9 mix=81.1 hardTopK=53.1  evals=860
  fit=0.7hard+0.3easy  useC=1 λ=8.00 τ=0.020 k=4 sep=0.104  easy=87.4 hard=74.9 mix=81.1 hardTopK=53.1  evals=860
  fit=0.7hard+0.3hardTopK  useC=1 λ=8.00 τ=0.020 k=4 sep=0.104  easy=87.4 hard=74.9 mix=81.1 hardTopK=53.1  evals=863
  fit=hard λ≤16  useC=0 λ=16.00 τ=0.020 k=1 sep=0.077  easy=86.8 hard=76.1 mix=81.5 hardTopK=55.1  evals=874
  fit=hard saved-only  useC=1 λ=8.00 τ=0.020 k=4 sep=0.104  easy=90.8 hard=77.2 mix=84.0 hardTopK=53.7  evals=858

=== 8. Per-kit GA vs grid vs λ=8 (train A, test B) ===
  heatmap top-5 on fold B (confirm, not used for picking)
    A-best λ=16 τ=0.02  A easy=86.8 hard=76.1 mix=81.5 hardTopK=55.1  B easy=87.0 hard=76.2 mix=81.6 hardTopK=54.2
    A-best λ=12 τ=0.02  A easy=87.1 hard=75.7 mix=81.4 hardTopK=53.7  B easy=87.3 hard=75.9 mix=81.6 hardTopK=53.7
    A-best λ=16 τ=0.04  A easy=87.2 hard=75.5 mix=81.4 hardTopK=53.7  B easy=87.4 hard=75.7 mix=81.5 hardTopK=53.0
    A-best λ=10 τ=0.02  A easy=87.3 hard=75.4 mix=81.4 hardTopK=53.4  B easy=87.4 hard=75.6 mix=81.5 hardTopK=53.5
    A-best λ=16 τ=0.06  A easy=87.3 hard=75.0 mix=81.1 hardTopK=53.1  B easy=87.5 hard=75.2 mix=81.3 hardTopK=52.7
    A-proposed λ=8 τ=0.06  B easy=87.0 hard=73.4 mix=80.2 hardTopK=50.6
  kits=29 19473ms
  vs λ=8 default on B: dense-grid Δ=2.48pp  mix-picked Δ=3.23pp  GA Δ=3.28pp
  grid≥2pp 14  mix≥2pp 14  GA≥2pp 17  grid hurt 2  mix hurt 1  GA hurt 2
  mean hard B  def8=73.4 grid=75.9 mixPick=76.7 ga=76.7
  A-picks: c1 λ=16 τ=0.04×16  c1 λ=0 τ=0.04×6  c1 λ=16 τ=0.12×2  c1 λ=16 τ=0.06×2  c1 λ=8 τ=0.12×1  c0 λ=4 τ=0.12×1  c1 λ=10 τ=0.12×1

=== 9. Two-stage (centroid shortlist, then λ=8) ===
  k=20   easy=82.5 hard=65.9 mix=74.2 hardTopK=44.0
  k=40   easy=82.6 hard=66.7 mix=74.7 hardTopK=44.0
  k=80   easy=82.5 hard=68.0 mix=75.2 hardTopK=47.0
  k=160  easy=83.5 hard=70.8 mix=77.1 hardTopK=51.1
  full λ=8     easy=86.9 hard=72.9 mix=79.9 hardTopK=51.6

=== 10. Arity split (cen λ=8 vs prod, fold A) ===
  arity=2 n=10  prod easy=62.7 hard=55.6 mix=59.2 hardTopK=37.1  cen8 easy=79.5 hard=68.3 mix=73.9 hardTopK=48.5
  arity=3 n=10  prod easy=73.0 hard=62.9 mix=68.0 hardTopK=35.6  cen8 easy=89.6 hard=75.2 mix=82.4 hardTopK=51.3
```



### Reading

Jaccard-4 was the wrong proxy. CLIP-NN and tag-subset are worse. `savedAll` ≈ `allKits` and is what the app does. With only 4 rivals, λ=16 τ=0.02 still looked like the cap because the gene box was too small; LOO picked the highest λ we offered (12), not because 12 is special.

Mahalanobis and k-means-2 do not beat centroid once rivals are on. Two-stage shortlist throws away exclusivity. Seed cap 40 is enough. Arity-2/3 both gain from centroid λ=8 vs medoids.

The per-kit GA “beat” λ=8 on Jaccard-4 by picking λ=16 — that’s a default bug, not a tuner win. Six kits picking λ=0 on that proxy is overfit noise.

Logs below; **the default decision is in pass 3b**, not this Jaccard-4 heatmap.

## Pass 3b — production rivals (`savedAll`) (2026-09-09)

Jaccard-4 was the wrong proxy. The app already uses **every other saved kit** as a rival. This retune is the one that matters for the default genome.

```
pass3b folds=29 saved=19 meanRivals=18.3

=== savedAll heatmap hard (all eval kits) ===
            τ0.02  τ0.04  τ0.06  τ0.12   τ0.2
  λ=0     65.2   65.2   65.2   65.2   65.2
  λ=4     78.5   77.5   76.6   74.5   72.7
  λ=8     80.9   80.2   79.6   77.9   76.1
  λ=12    81.7   81.3   80.8   79.5   78.0
  λ=16    82.1   81.8   81.5   80.4   79.1
  λ=20    82.2   82.1   81.8   81.0   79.9
  λ=24    82.3   82.2   82.1   81.4   80.5

=== savedAll heatmap hard (saved presets only) ===
            τ0.02  τ0.04  τ0.06  τ0.12   τ0.2
  λ=0     65.5   65.5   65.5   65.5   65.5
  λ=4     79.9   78.7   77.8   75.6   73.7
  λ=8     82.4   81.7   80.9   79.2   77.4
  λ=12    83.3   82.8   82.3   80.8   79.3
  λ=16    83.7   83.4   83.0   81.8   80.5
  λ=20    83.9   83.7   83.4   82.5   81.3
  λ=24    84.1   83.9   83.6   82.9   81.9

=== savedAll heatmap easy (all kits) — watch for collapse ===
            τ0.02  τ0.04  τ0.06  τ0.12   τ0.2
  λ=0     82.5   82.5   82.5   82.5   82.5
  λ=4     92.3   91.9   91.5   90.4   89.2
  λ=8     93.2   93.1   92.9   92.3   91.4
  λ=12    93.4   93.4   93.3   93.0   92.4
  λ=16    93.4   93.5   93.5   93.3   92.9
  λ=20    93.4   93.5   93.6   93.4   93.2
  λ=24    93.4   93.5   93.6   93.5   93.3
  best-all-hard  λ=24 τ=0.02 easy=93.4 hard=82.3 mix=87.9 hardTopK=61.1
  best-saved-hard λ=24 τ=0.02 easy=95.2 hard=84.1 mix=89.6 hardTopK=61.0
  best-all-mix   λ=24 τ=0.04 easy=93.5 hard=82.2 mix=87.9 hardTopK=61.1

=== confirm top cells + proposed on fold B ===
  λ=8 τ=0.06  A easy=92.9 hard=79.6 mix=86.3 hardTopK=57.6  B easy=92.9 hard=80.2 mix=86.5 hardTopK=57.6  B-saved easy=94.8 hard=81.8 mix=88.3 hardTopK=57.1
  λ=8 τ=0.02  A easy=93.2 hard=80.9 mix=87.1 hardTopK=59.7  B easy=93.2 hard=81.5 mix=87.4 hardTopK=60.5  B-saved easy=95.2 hard=83.3 mix=89.2 hardTopK=60.3
  λ=12 τ=0.06  A easy=93.3 hard=80.8 mix=87.1 hardTopK=59.3  B easy=93.3 hard=81.4 mix=87.4 hardTopK=59.8  B-saved easy=95.3 hard=83.1 mix=89.2 hardTopK=59.2
  λ=16 τ=0.06  A easy=93.5 hard=81.5 mix=87.5 hardTopK=60.4  B easy=93.4 hard=82.0 mix=87.7 hardTopK=61.2  B-saved easy=95.4 hard=83.8 mix=89.6 hardTopK=61.0
  λ=16 τ=0.02  A easy=93.4 hard=82.1 mix=87.7 hardTopK=61.0  B easy=93.3 hard=82.5 mix=87.9 hardTopK=62.1  B-saved easy=95.3 hard=84.5 mix=89.9 hardTopK=61.9
  λ=24 τ=0.02  A easy=93.4 hard=82.3 mix=87.9 hardTopK=61.1  B easy=93.2 hard=82.8 mix=88.0 hardTopK=61.9  B-saved easy=95.3 hard=84.8 mix=90.0 hardTopK=61.8
  λ=24 τ=0.04  A easy=93.5 hard=82.2 mix=87.9 hardTopK=61.1  B easy=93.4 hard=82.7 mix=88.0 hardTopK=61.9  B-saved easy=95.4 hard=84.6 mix=90.0 hardTopK=61.7

=== stability (savedAll, hard AUC, all kits) ===
  seed            λ0    8/0.06    8/0.02   12/0.06   16/0.06   16/0.02   24/0.02
  7             65.5      78.9      80.2      80.2      80.8      81.3      81.6
  42            65.2      79.6      80.9      80.8      81.5      82.1      82.3
  99            66.0      80.2      81.5      81.4      82.0      82.5      82.8
  123           66.9      78.7      79.7      79.8      80.3      80.7      80.9
  2024          65.9      79.2      80.6      80.5      81.1      81.5      81.8
  meanH         65.9      79.3      80.6      80.5      81.1      81.6      81.9
  minH          65.2      78.7      79.7      79.8      80.3      80.7      80.9
  meanE         82.6      92.7      93.1      93.2      93.3      93.3      93.2

=== per-kit tuner vs production-like defaults (train A / test B, savedAll) ===
  default λ8/0.06: meanB=80.2  hard-grid Δ=2.74pp  mix-grid Δ=2.67pp  ≥2pp 17  hurt 0
    A-picks: λ24/τ0.02×18  λ24/τ0.06×5  λ24/τ0.12×1  λ12/τ0.02×1  λ16/τ0.06×1  λ16/τ0.02×1  λ0/τ0.02×1  λ8/τ0.06×1
  default λ16/0.06: meanB=82.0  hard-grid Δ=0.97pp  mix-grid Δ=0.91pp  ≥2pp 4  hurt 0
    A-picks: λ24/τ0.02×18  λ24/τ0.06×5  λ24/τ0.12×1  λ12/τ0.02×1  λ16/τ0.06×1  λ16/τ0.02×1  λ0/τ0.02×1  λ8/τ0.06×1
  default λ16/0.02: meanB=82.5  hard-grid Δ=0.42pp  mix-grid Δ=0.36pp  ≥2pp 1  hurt 0
    A-picks: λ24/τ0.02×18  λ24/τ0.06×5  λ24/τ0.12×1  λ12/τ0.02×1  λ16/τ0.06×1  λ16/τ0.02×1  λ0/τ0.02×1  λ8/τ0.06×1
```



### Reading

This is the table that should drive the default. λ=16 τ=0.02 is the start of the plateau: +2.3pp hard vs λ=8 τ=0.06 on 5 seeds (min 80.7 vs 78.7), confirmed on fold B (saved kits **84.5%** hard). λ=24 is only +0.3pp more. Easy AUC is flat at ~93% from λ=8 on — we are not trading recall of unrelated photos.

Tuner vs this default: +0.42pp mean, one kit ≥2pp, zero hurts. Ship λ=16 τ=0.02 globally; leave a tiny grid for the odd kit; do not run a GA.

## Pass 4 — leakage-free scorers (2026-09-09)

Global 60/40 photo split: an evaluated photo is absent from **every** selected,
rival, hard-negative, and tag prototype. dHash-near-duplicate groups (Hamming
≤6) stay on one side. Seed 42 selected one fixed
candidate per family; seeds 99/123/2024/7 confirmed them.
Metrics use every tagged test photo, not a 180-negative sample. `hard@12` and
`full@12` use K=min(12, held-out positives).

```
corpus photos=5723 kits=35
duplicate groups=303 photos-in-groups=1593
development train=3433 test=2290 folds=28

Development top:
  prod + neg a32 + tag-min a32               hard=88.7 hardAP=49.1 hard@12=67.6 fullAP=48.1 full@12=67.1 easy=96.2 obj=72.6
  prod + neg a32 + tag-min a24               hard=88.9 hardAP=49.3 hard@12=66.7 fullAP=48.1 full@12=65.7 easy=96.1 obj=72.6
  prod + neg a8 + tag-min a8                 hard=88.1 hardAP=49.3 hard@12=68.5 fullAP=48.3 full@12=68.1 easy=96.5 obj=72.5
  prod + neg a24 + tag-min a24               hard=88.7 hardAP=49.1 hard@12=67.1 fullAP=48.1 full@12=67.1 easy=96.3 obj=72.5
  prod + neg a16 + tag-min a16               hard=88.5 hardAP=49.3 hard@12=67.1 fullAP=48.3 full@12=67.1 easy=96.5 obj=72.5
  prod + neg a6 + tag-min a4                 hard=87.8 hardAP=49.2 hard@12=69.0 fullAP=48.1 full@12=68.1 easy=96.4 obj=72.5
  prod + neg a24 + tag-min a16               hard=88.9 hardAP=49.2 hard@12=66.2 fullAP=48.0 full@12=65.3 easy=96.2 obj=72.4
  prod + neg a12 + tag-min a12               hard=88.4 hardAP=49.3 hard@12=67.1 fullAP=48.3 full@12=67.1 easy=96.5 obj=72.4
  prod + neg a16 + tag-min a12               hard=88.7 hardAP=49.4 hard@12=66.2 fullAP=48.2 full@12=65.7 easy=96.4 obj=72.4
  prod + neg a12 + tag-min a8                hard=88.5 hardAP=49.4 hard@12=66.2 fullAP=48.2 full@12=65.3 easy=96.4 obj=72.3
  prod + neg a4 + tag-min a2                 hard=87.3 hardAP=48.5 hard@12=70.4 fullAP=47.3 full@12=69.4 easy=96.2 obj=72.3
  prod + neg a12 + tag-min a16               hard=88.2 hardAP=49.1 hard@12=67.1 fullAP=48.2 full@12=66.7 easy=96.5 obj=72.3
  prod + neg a32 + tag-min a16               hard=89.0 hardAP=49.0 hard@12=65.3 fullAP=47.6 full@12=64.4 easy=95.9 obj=72.2
  prod + neg a8 + tag-min a4                 hard=88.1 hardAP=49.1 hard@12=67.1 fullAP=47.8 full@12=66.2 easy=96.4 obj=72.2
  prod + neg a16 + tag-min a8                hard=88.7 hardAP=49.2 hard@12=65.3 fullAP=47.9 full@12=64.8 easy=96.2 obj=72.2
  prod + neg a24 + tag-min a12               hard=88.9 hardAP=49.1 hard@12=64.8 fullAP=47.8 full@12=64.4 easy=96.1 obj=72.1
  prod + neg a4 + tag-min a4                 hard=87.4 hardAP=48.8 hard@12=69.0 fullAP=47.7 full@12=68.5 easy=96.4 obj=72.1
  prod + neg a4 + tag-min a1                 hard=87.1 hardAP=48.1 hard@12=70.4 fullAP=46.7 full@12=69.4 easy=96.1 obj=72.1

Confirmation mean (saved kits):
  prod + neg a8 + tag-min a8                 hard=88.0 hardAP=50.1 hard@12=70.4 fullAP=49.0 full@12=69.9 easy=96.6 Δhard=3.57pp CI=[2.68,4.51] +2pp=12 -2pp=0
  prod + neg a32 + tag-min a32               hard=88.6 hardAP=49.6 hard@12=67.2 fullAP=48.5 full@12=66.9 easy=96.3 Δhard=4.10pp CI=[2.85,5.46] +2pp=13 -2pp=0
  prod + neg a32 + tag-min a24               hard=88.7 hardAP=49.6 hard@12=66.8 fullAP=48.3 full@12=66.4 easy=96.1 Δhard=4.20pp CI=[3.04,5.49] +2pp=13 -2pp=0
  production + negative a16                  hard=87.9 hardAP=47.3 hard@12=61.0 fullAP=45.3 full@12=59.8 easy=95.4 Δhard=3.46pp CI=[2.45,4.60] +2pp=12 -2pp=0
  production + global tag min a8             hard=86.0 hardAP=45.6 hard@12=66.0 fullAP=44.8 full@12=65.8 easy=96.3 Δhard=1.52pp CI=[0.76,2.40] +2pp=7 -2pp=0
  soft rival T0.01 a16                       hard=85.2 hardAP=45.6 hard@12=66.9 fullAP=44.1 full@12=66.3 easy=95.9 Δhard=0.73pp CI=[-0.10,1.45] +2pp=3 -2pp=2
  symmetric margin top1 a16                  hard=84.6 hardAP=42.3 hard@12=61.4 fullAP=40.5 full@12=61.0 easy=95.5 Δhard=0.13pp CI=[0.02,0.25] +2pp=0 -2pp=0
  production all seeds                       hard=84.5 hardAP=41.9 hard@12=59.0 fullAP=40.1 full@12=58.4 easy=95.4 Δhard=0.08pp CI=[-0.05,0.21] +2pp=0 -2pp=0
  production λ16/τ.02 cap150                 hard=84.5 hardAP=41.3 hard@12=56.6 fullAP=39.4 full@12=56.0 easy=95.4 Δhard=0.00pp CI=[0.00,0.00] +2pp=0 -2pp=0

Per-kit weight tune:
picks: prod + neg a8 + tag-min a8×8  prod + neg a2 + tag-min a2×1  prod + neg a12 + tag-min a2×1  prod + neg a12 + tag-min a1×1  prod + neg a4 + tag-min a1×1  prod + neg a2 + tag-min a32×1  prod + neg a32 + tag-min a24×1  prod + neg a16 + tag-min a32×1  prod + neg a4 + tag-min a12×1  prod + neg a6 + tag-min a4×1  prod + neg a24 + tag-min a8×1
fixed 8/8 hard=88.0 hardAP=50.1 hard@12=70.4 fullAP=49.0 full@12=69.9 easy=96.6
tuned     hard=88.3 hardAP=51.1 hard@12=73.3 fullAP=50.0 full@12=72.6 easy=96.6 Δhard=0.26pp CI=[-0.03,0.67]
first-screen Δhard@12=2.89pp CI=[0.81,5.21] Δfull@12=2.66pp CI=[0.81,4.75]

Reserved three-way result:
train=3433 validation=1144 test=1146
validation picked: prod + neg a8 + tag-min a8
baseline hard=84.4 hardAP=45.7 hard@12=58.3 fullAP=43.8 full@12=57.8 easy=96.8
winner   hard=88.3 hardAP=54.9 hard@12=71.9 fullAP=53.9 full@12=71.9 easy=97.7
Δhard=3.85pp CI=[2.71,5.04] +2pp=12 -2pp=0
```



## Pass 4 interpretation and handoff

> Superseded by **Pass 5** (end of file) for the scorer itself. The protocol,
> production integration map, fallbacks, tuner implications and definition of
> done below still apply; pass 5 changes only how the two margins are computed.

The old result survives the stricter protocol: production is still **84.4–84.5%
hard AUC**, so the λ=16/τ=0.02 gain was not an artefact of evaluated photos
leaking into rival prototypes.

There is, however, one clearly better scoring family:

1. Keep the current centroid + saved-rival production score.
2. Add a **hard-negative margin**: selected-centroid similarity minus similarity
  to the centroid of training photos that have *some but not all* kit tags.
3. Add the weakest **per-tag visual margin**: for every tag in the AND kit,
  compare similarity to that tag's positive and negative centroids, then take
   the minimum. This directly penalises a photo that visually misses one
   constituent tag.

Balanced weights `negative=8`, `tag-min=8` were selected by the reserved
validation set. More aggressive 24–32 weights bought another ~0.5pp hard AUC
but made the first screen worse, so they are not the quality recommendation.

On the untouched reserved test partition, saved-kit results were:

- hard AUC **84.4% → 88.3%** (+3.85pp, paired kit bootstrap 95% CI
**+2.71 to +5.04pp**);
- hard average precision **45.7% → 54.9%**;
- hard first-screen hit rate **58.3% → 71.9%**;
- full-pool average precision **43.8% → 53.9%**;
- full-pool first-screen hit rate **57.8% → 71.9%**;
- easy AUC **96.8% → 97.7%**;
- 12 saved kits improved by at least 2pp hard AUC; none fell by 2pp.

The same family held under near-exact duplicate grouping (threshold 2) and an
overly broad threshold-10 stress test. Threshold 10 chained most of the library
into a few components and produced unbalanced splits, so it is only a direction
check, not headline evidence.

Using every positive seed instead of production's first 150 added only
**0.08pp** hard AUC. Symmetric rival margins added ~0.1pp; soft rivals added
~0.7pp with an interval crossing zero. Do not ship those.

Per-kit weight selection still has little AUC job (+0.26pp, CI crosses zero),
but it confirmed a **+2.9pp hard / +2.7pp full first-screen** lift over fixed
8/8 weights. If retained, Tune should search only the two new weights against
the 8/8 default and optimise first-screen retrieval; it should not revive the
old centroid/λ/τ GA.

### Recommendation

Implement the negative margin + weakest-tag margin with global weights 8/8,
using the existing S2 vectors and current production score. No rescan or new
fingerprint is needed. Benchmark ranking time before shipping; quality research
did not measure UI latency. Keep the current system as a fallback when a kit
has too few partial-tag negatives or a tag lacks both prototype classes.

### Exact scorer

The pass-4 script ranks with higher-is-better cosine scores. All embedding
vectors and all centroids are L2-normalised.

For selected kit tag set `K` and candidate vector `x`:

```text
s_selected = cosine(x, selected centroid)

weight_r = selected/rival centroid distance
           / (selected/rival centroid distance + 0.02)

steal = max over saved rivals r of
        weight_r * max(0, cosine(x, rival centroid r) - s_selected)

s_production = s_selected - 16 * steal
```

The two new terms are:

```text
H_K = training photos that have some but not all tags in K
c_hard = centroid(H_K)
m_hard = s_selected - cosine(x, c_hard)

p_t = centroid(training photos carrying tag t)
n_t = centroid(training photos not carrying tag t)
m_tag = min over t in K of (cosine(x, p_t) - cosine(x, n_t))

s_pass4 = s_production + 8 * m_hard + 8 * m_tag
```

The app sorts by lower-is-better distance. The equivalent production formula
is therefore:

```text
d_pass4 = d_production - 8 * m_hard - 8 * m_tag
```

Do not use a candidate's tags directly while scoring it. Tags define training
sets and test truth only. The result is intended to generalise visually to an
untagged candidate.

Why the terms are complementary:

- `m_hard` directly learns the boundary between a complete AND kit and its
partial-tag sibling kits. It supplies most of the AUC gain.
- `m_tag` makes the weakest constituent tag matter. It supplies most of the
first-screen gain and prevents a visually strong match to one tag from
hiding a missing second/third tag.
- Saved-rival steal remains useful and is retained unchanged. The hard centroid
covers partial combinations even when no corresponding rival preset exists.



### Reproducing pass 4

The runner is `mobileapp/scripts/kit-nearness-s2-pass4.ts`. It reads the private
corpus directly from Downloads and never copies it into the repository.

From PowerShell:

```powershell
cd mobileapp
$env:PASS4_DUP_THRESHOLD='6'
$env:PASS4_WRITE_NOTES='1'
npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass4.ts
```

Useful duplicate-grouping stress runs:

```powershell
$env:PASS4_DUP_THRESHOLD='2'
$env:PASS4_WRITE_NOTES='0'
npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass4.ts

$env:PASS4_DUP_THRESHOLD='10'
$env:PASS4_WRITE_NOTES='0'
npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass4.ts
```

Threshold 6 is canonical. Threshold 2 keeps only near-exact groups together.
Threshold 10 is deliberately too broad: graph chaining puts most photos into a
few components and makes the nominal 60/40 split badly unbalanced.

`CORPUS_PATH` and `NOTES_PATH` are constants near the top of the runner. Change
`CORPUS_PATH` if the download moves. With notes enabled, the runner rewrites
only the generated `## Pass 4 — leakage-free scorers` section and preserves
this interpretation/handoff section.

### Pass-4 protocol, exactly

- Corpus version 3 contains tagged, non-archived stills only. It has no raw
images, real Ente IDs, tag names, kit names, timestamps or crop grids.
- The vectors and perceptual hashes remain private membership fingerprints.
Never commit, upload or paste the corpus.
- Evaluation membership is AND: a positive has every kit tag.
- A hard negative has some but not all kit tags. An easy negative has none.
- Eval kits are saved presets plus the 24 most frequent generated combinations
at arity 1, 2 and 3, then deduplicated at member-set Jaccard ≥0.85.
- Arity-1 kits are omitted from hard-negative evaluation.
- Minimum fold sizes are 8 training positives, 5 test positives, 16 hard
negatives and 24 easy negatives.
- dHash Stage-1 clustering at Hamming threshold 6 forms duplicate groups.
Every group is assigned wholly to one partition.
- A global partition is used for every kit. A test photo is excluded from
selected, rival, hard-negative and tag centroids simultaneously.
- Development uses a 60/40 split at seed 42. Confirmation fixes the selected
cells and repeats global 60/40 splits at seeds 99, 123, 2024 and 7.
- The final reserved split uses seed 314159 and 60/20/20
train/validation/test. The validation partition picked 8/8; the test
partition was not used for selection.
- Production selected/rival centroids retain the 150-seed cap. Hard-negative
and per-tag centroids use all eligible training photos.
- Every tagged test photo is ranked. There is no 180-negative sample.

Metrics:

- `hard AUC`: probability that a random held-out full member beats a random
partial-tag sibling.
- `easy AUC`: the same comparison against no-shared-tag photos.
- `hardAP`: average precision among positives plus all hard negatives.
- `fullAP`: average precision among positives plus all hard and easy negatives.
- `hard@12` / `full@12`: positive fraction in the first
`min(12, positive count)` results. This is a first-screen metric, not literal
precision@12 when fewer than 12 positives exist.
- Search objective: `0.5*hardAUC + 0.3*hardAP + 0.2*hard@12`.
- Confidence intervals resample saved kits 4,000 times. For repeated splits,
each kit's split deltas are averaged before bootstrapping.



### What was tested and what not to repeat

Pass 4 searched 223 fixed cells across:

- current production and all-seed centroids;
- symmetric top-1/top-3/top-5 rival margins;
- soft rival maxima at four temperatures;
- hard-negative centroid margins;
- global and sibling-conditioned per-tag min/mean margins;
- combinations of production, negative and tag margins;
- global and per-kit negative/tag weights.

Results that do not justify implementation:

- all positive seeds instead of the first 150: +0.08pp hard AUC;
- symmetric rival margins: about +0.1pp;
- soft rivals: about +0.7pp, confidence interval crosses zero;
- medoids, dHash, colour, kNN and trimmed/core centroids: already lost in prior
passes;
- more λ/τ tuning: production is already on that family’s plateau;
- aggressive 24–32 negative/tag weights: slightly higher global AUC but worse
first-screen retrieval than balanced 8/8.

Mahalanobis gained 0.7pp in the earlier fingerprint-only pass, but the pass-4
gain is much larger and simpler. It is not the next priority.

### Production integration map

The simplest first implementation should use global constants only. Do not
expand the persisted genome until the global scorer has passed phone QA.

1. `mobileapp/src/lib/kit-nearness-sort.ts`
  - `buildKitEmbeddingCentroid` is the existing selected/rival prototype.
  - `kitEmbeddingDistanceCompetitive` is the current λ=16/τ=0.02 distance.
  - `sortFilesByKitEmbeddingCompetitive` is the ranking seam.
  - Add plain helpers to build a hard-negative centroid and per-tag
  positive/negative centroids, then apply the two margins.
  - Suggested constants:
  `KIT_EMBEDDING_HARD_NEGATIVE_WEIGHT = 8` and
  `KIT_EMBEDDING_WEAKEST_TAG_WEIGHT = 8`.
2. `mobileapp/src/pages/gallery.tsx`
  - `frozenNearnessOrderIds` builds selected and every-other-saved-kit rival
   prototypes, then calls the sort seam.
  - Start by enabling pass 4 only when `matchedKit` exists, using
  `matchedKit.tags`. That matches the saved-kit headline evidence.
  - Treat both new terms as exclusivity evidence: respect the existing Kit
  likeness rival-penalty toggle. Filter nearness currently always enables
  exclusivity.
3. `mobileapp/src/lib/__tests__/kit-nearness-sort.test.ts`
  - Add formula, missing-prototype, arity-1 and deterministic tie tests.
4. Benchmark a large gallery on phone before shipping, then run
  `npm run lint` and `npm run build`, and bump `APP_VERSION`.

Prototype eligibility must match current CLIP seeds: embedded stills only,
exclude archived files and videos. Use the same user-tag/kit-nearness allowlist
semantics as the selected preset. Keep every prototype in memory only; do not
persist derived visual/tag models.

Build prototypes once per frozen nearness snapshot. Avoid adding several
512-dimensional dot products inside the JavaScript sort comparator. Prefer:

1. one pass to accumulate required centroids;
2. one pass to compute one final score per still;
3. sort cached `{ file, score }` rows with file ID as the deterministic tie
  break.

Per-tag prototypes can be built cheaply: accumulate one total vector/count and
one vector/count per required tag. A tag's negative sum is `total - positive`,
then normalise both centroids. The selected kit's hard-negative centroid needs
one pass selecting `sharesAny && !hasAll`.

Fallback behaviour:

- no selected centroid: preserve the existing unsorted fallback;
- fewer than two kit tags, no partial-tag negatives or no hard centroid: use
current production distance;
- missing positive or negative class for any constituent tag: use current
production distance for the first implementation, rather than silently
changing the min over tags;
- invalid/missing candidate embedding: continue sorting it last;
- never apply these margins to videos.

The research held every scored candidate out of all prototypes. In the live
library, a known partial-tag photo can contribute to the hard/tag training
centroids that penalise it. That is reasonable supervised behaviour, but do not
claim it as additional measured lift and do not add direct tag-based ranking
shortcuts.

### Tuner implications

The current tuner lives in:

- `mobileapp/src/lib/kit-nearness-embedding-genome.ts`;
- `mobileapp/src/lib/kit-nearness-embedding-eval.ts`;
- `mobileapp/src/lib/kit-nearness-embedding-tune.ts`;
- `mobileapp/src/components/manage/ManageTagsPanel.tsx`.

Do not merely add the new weights to the existing 15-cell λ/τ tuner. Its fold
samples generic negatives and builds rival prototypes independently; it does
not implement pass 4's global leakage rule or full-pool first-screen objective.

If a second implementation pass keeps per-kit tuning:

- globally partition all eligible embedded photos before deriving every
prototype;
- tune only negative/tag weights around the global 8/8 default;
- optimise first-screen retrieval as well as hard AUC;
- retain the ≥2pp improvement gate;
- bump `KIT_NEARNESS_TUNE_VERSION` and update the persisted result shape rather
than supporting old and new tune formats in parallel.

On this corpus the tuner changed hard AUC by only +0.26pp (uncertain), but
improved held-out first-screen metrics by +2.7–2.9pp. That makes it a plausible
second step, not a prerequisite for the global scorer.

### Remaining research with the highest value

1. **A second independent library/export.** This is now more valuable than
  another weight sweep. All current confidence intervals cover variation
   across kits in one user's taxonomy, not cross-library generalisation.
2. **An untagged-inclusive corpus.** Corpus v3 exports tagged photos only.
  Production nearness can rank untagged photos, so current `fullAP` is still a
   tagged-library metric. Extend the private exporter/harness to include
   embedding-only untagged stills as candidates without exposing metadata.
3. **Balanced hard-negative prototypes.** The current centroid weights each
  partial photo equally. Compare equal weighting per missing-tag pattern so a
   common sibling combination cannot dominate.
4. **Calibrated tag margins.** Compare per-tag variance/sample-count
  normalisation, but require gains on a reserved split; do not tune on all
   five repeated folds.
5. **Phone latency and memory.** Quality is proven; runtime cost is not. Measure
  prototype build time, score time and peak heap separately.

Model swaps or ensembles cannot be evaluated from this corpus because it has
only MobileCLIP-S2 vectors, not image bytes. They require a new private rescan
and should follow, not precede, the inexpensive pass-4 implementation.

### Definition of done for the next agent

- Formula and fallbacks above are covered by unit tests.
- Saved-kit nearness uses 8/8 only when exclusivity is enabled.
- Scores are precomputed once per candidate, not recomputed by the comparator.
- Archived files, videos and missing embeddings preserve current behaviour.
- Existing tune blobs are handled deliberately if the tune schema changes.
- `npm run lint` and `npm run build` pass.
- `APP_VERSION` is bumped once.
- Phone QA confirms ranking latency is acceptable and visually checks several
complete members, hard sibling negatives and untagged candidates.
- This log is updated with measured runtime, final implementation choices and
any deviation from the researched formula.



## Pass 5 — whitened hard margin + learned per-tag directions (2026-09-09)

Runner: `mobileapp/scripts/kit-nearness-s2-pass5.ts` (~2 min per full run,
5× faster than the first pass-5 runner after moving LR to whitened
coordinates, sharing per-split similarities across folds and sorting once per
evaluation). Protocol is pass 4's exactly: global 60/40 split with dHash
duplicate groups kept on one side, every scored photo absent from every
prototype and every training set, dev seed 42, confirmation seeds
99/123/2024/7, reserved 60/20/20 split seed 314159 whose validation partition
picks the cell and whose test partition is reported once.

### Result

Confirmation seeds, saved kits (18), mean of four seeds:


| scorer                         | hard AUC | hard AP  | hard first-screen | full AP  | easy AUC |
| ------------------------------ | -------- | -------- | ----------------- | -------- | -------- |
| production (0.3.119)           | 84.5     | 41.3     | 56.6              | 39.4     | 95.4     |
| pass 4 (8/8 raw margins)       | 88.0     | 50.1     | 70.4              | 49.0     | 96.6     |
| **pass 5** (`l2=0.01 h1.5 t4`) | **93.0** | **61.1** | **76.4**          | **60.7** | **98.1** |


All 28 arity ≥2 kits: hard AUC 82.5 → 87.0 → **92.6**; hard first-screen
61.6 → 74.5 → **80.8**.

Paired per-kit deltas vs pass 4 (saved kits): hard AUC **+4.93pp, 95% CI
+3.67 to +6.26**, 15/18 kits ≥ +2pp, 0 kits ≤ −2pp; first-screen **+6.02pp,
CI +2.78 to +9.49**, 13 up / 2 down.

Reserved split, untouched test partition (26 folds): validation picked
`l2=0.001 h1 t3` → test hard AUC 88.3 → **92.8** (+4.50pp, CI +2.47 to
+6.70, 12 up / 1 down); the dev-best cell scored 93.3 (+4.98pp). Versus
production on that test partition: **+8.35pp hard AUC (CI +5.72 to +10.96)**
and **+15.6pp first-screen (CI +8.85 to +22.40)**.

Stress: duplicate threshold 2 (near-exact groups only) +4.95pp AUC /
+9.2pp first-screen, reserved test +5.98pp; threshold 10 +5.24pp / +13.5pp
(its reserved split degenerates to an empty test partition, as in pass 4 —
direction check only).

### The scorer

Higher is better; all vectors and centroids L2-normalised. `s_production`,
`c_selected`, `c_hard` (centroid of training photos with some but not all kit
tags) are exactly as in the pass-4 section. New global objects, built once from
the training population `X` (the embedded, tagged stills the models learn
from):

```text
μ   = mean of X
S   = covariance of X (512×512, mean-centred)
S_α = S + (α · trace(S) / 512) · I         α = 1
L   = cholesky(S_α)                         S_α = L Lᵀ
```

Hard-negative term (shrunk LDA direction instead of the raw centroid
difference):

```text
w_hard   = S_α⁻¹ (c_selected − c_hard)      two triangular solves with L
m_hard(x) = x · w_hard
```

Per-tag term (one class-balanced logistic regression per kit tag, trained in
whitened coordinates, mapped back so scoring is one dot product):

```text
z_i = L⁻¹ (x_i − μ)                                for every training photo
minimise  mean_i  ω_i · logloss(y_i, z_i · w + b)  +  ½ · λ · ‖w‖²
          y_i = 1 if photo carries tag t, ω_pos = n / 2·n_pos, ω_neg = n / 2·n_neg
          λ = 0.01, Adam lr 0.1, 100 iterations from zero, deterministic row order
w_t = L⁻ᵀ w          b_t = b − μ · w_t
logodds_t(x) = x · w_t + b_t
m_tag(x) = min over t in K of logodds_t(x)
```

Combination, with `σ_·` the standard deviation of each term over the training
population (one pass; keeps weights unit-free):

```text
s_pass5 = s_production / σ_prod  +  1.5 · m_hard / σ_hard  +  4 · m_tag / σ_tag
```

The weight surface is a plateau, not a peak: every cell with hard weight
0.5–2 and tag weight 2–6 lies within 92.4–93.1 dev hard AUC, and λ from 0.001
to 0.03 confirms within 0.2pp. `h1 t3` is the centre of the plateau (92.8 /
76.2 on confirmation) and equally acceptable; lower hard weight trades ~0.3pp
AUC for ~1pp first-screen. Do not tune these.

Why it works: the raw centroid difference is dominated by directions along
which *all* photos vary; solving against the shrunk covariance rescales it to
the discriminative directions (this alone is +2.8pp over pass 4). The
per-tag logistic direction does the same for each constituent tag and, because
the L2 penalty acts in whitened space, it is a scale-free regulariser — the
same model trained with L2 in raw coordinates is 1.2pp worse (91.6) because
raw-space L2 quietly over-regularises the low-variance directions that carry
the signal. `min` over tags is kept: summing log-odds (product of experts) is
~2pp AUC and ~8pp first-screen worse.

### Ablations (confirmation seeds, saved kits)


| variant                                         | hard AUC | first-screen | read                                              |
| ----------------------------------------------- | -------- | ------------ | ------------------------------------------------- |
| full pass 5                                     | 93.0     | 76.4         | —                                                 |
| drop hard term (`h0`)                           | 91.8     | 74.0         | keep the whitened hard margin                     |
| drop rival steal (plain centroid)               | 92.2     | 76.2         | keep production's λ=16 steal                      |
| drop centroid + steal entirely (LR + hard only) | 93.0     | 75.2         | production term now matters only for first screen |
| LR trained on 2000-row subsample                | 92.6     | 75.6         | acceptable fallback for large libraries           |
| per-kit weight tuning                           | 93.1     | 77.1         | +0.15pp, CI crosses zero — no tuner               |




### Tested and not worth repeating

- Shrinkage α ∈ {0.3, 1, 3}: flat within 0.3pp. Use α = 1.
- Balanced hard-negative prototype (equal weight per missing-tag pattern):
worse than the plain hard centroid in both raw and whitened form (88.6 vs
90.9). Closes pass-4 remaining item 3.
- Whitened rival steal, whitened kit-vs-rest direction: ≤ 0.1pp.
- Learned kit-vs-hard logistic direction instead of the LDA direction: 90.5 vs
90.9 — the closed form wins and costs nothing.
- LR λ = 1e-4: 1pp worse and slow to converge (near-separable classes).
- Covariance from a 500/1000/2000-row sample: AUC within 0.6pp but
first-screen −2 to −3pp. Use every training row; it costs 0.5 s for 3400
rows.
- Fixed (un-normalised) weights with a unit whitened direction: 90.3 vs 90.9.
Keep the σ normalisation; it is one cheap pass.
- Per-kit tuning of the two weights: +0.15pp at threshold 6, +0.6pp at
threshold 10. Not worth a tuner.



### Production recipe and measured cost

Desktop Node, 3433 training rows: covariance 0.46 s, Cholesky 25 ms, whitening
0.42 s, one logistic model ≈ 4 ms per iteration (≈ 1.2 µs per row-iteration),
so 100 iterations ≈ 0.4 s per tag. Per-candidate scoring adds `1 + |K|` dot
products to the existing rival loop — negligible.

1. Build `μ`, `S_α`, `L` once per session from eligible embedded tagged stills
  (same eligibility as CLIP seeds: stills, not archived, not videos). Cache
   in memory; rebuild when tag assignments or embeddings change. Never
   persist.
2. Train logistic models lazily, **only for the tags of the selected kit**
  (2–3 models, not all tags), in a web worker. Cap training rows at ~3000
   (fixed-seed uniform sample) — measured −0.4pp AUC / −0.8pp first-screen —
   so a 20k-photo library stays ≈ 0.5 s desktop / a few seconds phone per tag.
   Zero init, fixed iteration count and fixed row order make the model
   deterministic. The research runner warm-starts λ = 0.01 from a λ = 0.03
   solution (60 + 60 iterations); the objective is convex, so a single run
   from zero reaches the same optimum — the loss plateaued by iteration 75 in
   the convergence bench. Assert that in the implementation test.
3. Per frozen nearness snapshot: `c_selected`, `c_hard`, `w_hard` (two
  triangular solves), then one pass over candidates for the three raw terms,
   one pass over the training population for `σ`, then score and sort with
   file ID as tie break — the same shape as the pass-4 integration map.

Fallbacks, in addition to pass 4's:

- kit with one tag: no hard negatives exist, so use
`s_production / σ_prod + 4 · m_tag / σ_tag`. This degenerate case is
well-defined but **unmeasured** (the protocol drops arity-1 kits); keeping
current production for arity 1 is the zero-risk alternative.
- a kit tag with fewer than ~8 positives or no negatives in the training
population: current production distance (the research required ≥ 8 training
positives per kit).
- a tagged candidate contributed to the models that score it — same caveat as
pass 4; do not claim it as measured lift.



### Implementation (`0.3.120`, 2026-09-10)

Shipped as three modules mirroring the relative-sort trio:

- `src/lib/kit-nearness-margins.ts` — packed-array maths, no EnteFile/DOM:
`buildKitWhitening` (mean, shrunk covariance, Cholesky, whitened rows),
`trainTagLogOddsModel` (class-balanced Adam in whitened space, 100 steps,
λ = 0.01, mapped back to raw space), `rankByKitMargins` (hard direction,
weakest-tag log-odds, σ over training rows, weights 1.5 / 4, id tie-break).
- `src/workers/kit-nearness-margins.worker.ts` — runs the above; caches the
whitening per training-id set and each tag model per label vector, so
switching kits within a session retrains only the new tags. Nothing is
persisted; the worker is terminated on logout.
- `src/lib/kit-nearness-margins-job.ts` — main thread: training population =
embedded, non-archived stills with ≥ 1 kit-nearness tag (same as the corpus
export), fixed-seed cap 3000; labels from `fileIdsByTag`; production score
from the existing `kitEmbeddingDistanceCompetitive` (negated) so medoids,
tuned genomes and λ/τ stay the single source of truth.

Gallery (`pages/gallery.tsx`): the production competitive order is still built
synchronously and shown immediately; the worker's order replaces it when it
lands. Fallbacks keep the production order: no matched kit, exclusivity toggle
off, fewer than two kit tags, fewer than 8 complete members / partial members /
tag positives / tag negatives in the training sample, or a worker failure.
Arity-1 kits deliberately use production (the zero-risk option above).

Differences from the research runner, all inside seed noise: `c_selected` is
the centroid of all sampled complete members (not the 150-seed production
centroid); one logistic run from zero (no warm-start ladder); ties by file id.

**Parity check** — the shipped functions were dropped into the pass-5 harness
as a scorer (rank of `rankByKitMargins` output) on the same folds:


| split                                    | production  | pass 4      | research pick h1.5 t4 | shipped code |
| ---------------------------------------- | ----------- | ----------- | --------------------- | ------------ |
| development (seed 42) hard AUC / hard@12 | 84.4 / 56.9 | 88.1 / 68.5 | 93.0 / 77.3           | 93.0 / 78.2  |
| confirmation ×4 seeds                    | 84.5 / 56.6 | 88.0 / 70.4 | 93.0 / 76.4           | 93.0 / 75.5  |
| reserved test                            | 84.4 / 58.3 | 88.3 / 71.9 | 93.3 / 75.0           | 93.3 / 74.5  |


Paired vs pass 4 (saved kits, seed-averaged): hard AUC +4.98pp, CI
[3.68, 6.36], 15 kits ≥ +2pp, none ≤ −2pp; hard@12 +5.09pp, CI [1.85, 8.45].
Shipped-code timing on desktop Node, 3433 rows: `buildKitWhitening` 0.94 s
(once per session), 0.34 s per tag model. Unit tests: Cholesky reconstruction,
whitening consistency, logistic separation + determinism + convergence at 100
steps, member-above-hard-negative ranking, id tie-break, and every builder
fallback (`__tests__/kit-nearness-margins*.test.ts`).

### Remaining research

1. **A second library/export** — still the most valuable check; every interval
  here covers variation across kits inside one taxonomy.
2. **Untagged-inclusive corpus** — unchanged from pass 4.
3. **Phone timing** — measure once on device: whitening at the 3000-row cap
  (expected 3–5 s, once per session) and one tag model (expected 1–1.5 s).
   If too slow, lower `KIT_MARGIN_TRAINING_ROW_CAP` (2000 measured at −0.4pp
   AUC / −0.8pp first-screen).

Not worth further digging on this corpus: weights, α, λ, solver variants,
per-kit tuning, hard-negative reweighting, tag aggregation. The remaining gap
to a perfect hard AUC is now 7pp; closing it needs a different model or image
bytes, not another scorer.

## Pass 6 — tile embeddings (pilot, concluded — negative)

> Result first: see **Batch 2** below. The design and gates in this section
> were written before the scan; the gates were not met. Tag ids in this
> section's first two subsections are from corpus (2); batch 2 uses corpus
> (3), where the 11% tag is `t_0001` and the 64% tag is `t_0007`.



### Why: the remaining error is two tags, not everything

Per-tag detectability with the shipped pass-5 logistic detectors (60/40 photo
split, test AUC of tag vs everything else, one seed): seven tags at 94–97.5%,
and two well below — `t_0005` (625 photos, 11%) **87.2%** and `t_0004`
(3,653 photos, 64%) **91.2%**; next weakest `t_0002` 93.9%.

Per kit, the hard negatives that beat true members are the ones **missing one
of those two tags**. Members vs negatives lacking `t_0004`, against members vs
negatives lacking the kit's other tags: `k_0013` 85.5 vs 94.7, `k_0016` 87.8
vs 97–98, `k_0017` 87.9 vs 98, `k_0022` 87.4 vs 95–96, `k_0021` (worst kit,
83.9 overall) 74.7 on `t_0004` / 83.4 on `t_0005` / 87.6 on `t_0003`. Pooled
over all kits: negatives lacking `t_0005` 91.3%, `t_0004` 92.9%; lacking
`t_0007` / `t_0006` 97.9% / 97.5%.

The owner confirms both are physically small items: the 64% tag is tiny in
frame, the 11% tag is small and inconsistent in appearance. Two mechanisms
lose them in the global vector:

- **Pooling / caption bias** — the embedding is a spatial aggregate trained to
match captions; a 3%-of-frame item contributes about 3% of the signal.
- **Centre crop** — `Xenova/mobileclip_s2` resizes the shortest edge to 256
and **centre-crops 256×256**. A 3:2 photo's outer sixth on each side is
never seen; portraits lose top and bottom. Edge items are absent, not
diluted. Thumbnails are ≤ 720 px on the long edge, so the model also sees a
~3× downsample.



### Design

Square tiles, side = shortest edge ÷ 3, covering the whole frame with the
last row / column snapped to the far edge (`src/lib/kit-tile-layout.ts`,
layout id `thirds-v1`): 3:2 → 3×5 = 15, 4:3 → 3×4 = 12, square → 9, 16:9 →
18. 160–240 px tiles into the 256 input is roughly the thumbnail's native
resolution — everything the thumbnail contains — and each region is a large
fraction of its tile. The 1/2-scale grid was dropped from the pilot to keep
the scan to ~13× the global scan; if 1/3 works, cheaper layouts are a
production question, not a research one.

Intended scorer: per tag `max over {global, tiles} of logodds_t`, kit score
still `min over tags` ("every kit component is visible somewhere"); the
production centroid and hard-margin terms stay on the global vector. Training
options in cost order: (a) none — apply the existing globally-trained
detectors per tile and max-pool; (b) multiple-instance logistic (max or
log-sum-exp pooling in the forward, positive if any tile fires, negative only
if none do). Also to test on the same data: a 2–3 sub-direction detector for
the inconsistent-appearance tag.

Decision gates: `t_0005` detector 87 → low 90s and the `t_0004` kits above
move by several points with CIs clear of zero. `t_0005` still under 90 → the
tag is not a spatial problem and tiles are dead for it. Watch for the
max-pool noise floor (more tiles = more chances for a spurious hit) and for
low-positive tags (`t_0006`, 223) getting worse — per-tag fallback to the
global detector should be part of any production design.

### Batch 1 — pilot scan + export (`0.3.121`, 2026-09-10)

Local builds only (Manage → Developer). Nothing in ranking changes; the phone
build gets an empty object store and no button.

- `src/lib/kit-tile-layout.ts` — grid geometry (unit-tested: shapes, full
coverage, in-bounds).
- `clip-embedding.worker.ts` — `embed-tiles`: decode the thumbnail once; per
tile one scaled `drawImage` into a 256² canvas and one pass into a packed
NCHW tensor (same maths as the processor for this model: canvas resample,
×1/255, `do_normalize: false` — bypasses its per-tile full-image canvas
copies); one ORT forward per photo, preprocessing outside the ORT queue so
the next photo's tiles are prepared while the GPU runs; returns one
transferred `Float32Array` (`rows × columns × 512`) plus preprocess /
forward ms. Any failed tile fails the photo — a partial grid would bias
max-over-tiles. The job logs a per-photo cost split (fetch / preprocess /
forward / store / wall) every 50 photos and aborts if the first 5 photos all
fail. Untried: two photos per forward (24–30 tiles) — measure first.
- `src/db/tile-embeddings.ts` — one encrypted record per file (cacheKey-wrapped
float32 matrix, like `file-ciphertexts`), tagged with model + layout id;
`getAllKeys` gives the resume set.
- `src/lib/kit-tile-embedding-job.ts` — eligible = owned stills that already
have a global vector; kit-nearness-tagged photos first so the corpus is
complete before the rest of the library; 6 thumbnails prefetching, 2 photos
in the worker; Stop is an abort and Resume skips stored files.
- Corpus export v4: photos gain `tiles: { offset, rows, columns }`, the JSON
gains `tileLayout`, `tileRows`, `tileSidecar`, and the tile matrix downloads
as a second file `<name>-tiles.f32` (little-endian float32, row-major in
photo order). Tiles are the same privacy class as the global vectors.

Scan outcome (owner's desktop, WebGPU): 5,882 tagged photos in ~13 min, all
succeeded, ~135 ms/photo after the preprocessing fusion. **Geometry flaw
found in the export:** `floor(shortEdge / 3)` makes the tile slightly smaller
than a third, so `ceil` adds a fourth, near-duplicate column along the short
edge whenever that edge is not divisible by 3 (grids came out 4×4 / 5×4 / 6×4
rather than 3-wide). Harmless for max-pooling and for the mean (a
near-duplicate tile cannot change a max and barely moves a mean), but it
inflates the count to **18.5 tiles/photo** instead of ~14, so the true cost of
exact thirds is ~25% below the measured 135 ms. Fix if ever revived: `ceil`
for the tile side, then bump the layout id (a rescan). Left as-is because
nothing ships.

### Batch 2 — results (2026-09-10)

Runner: `scripts/kit-nearness-s2-pass6.ts` (~19 min full; `PASS6_DEV_ONLY=1`
~4 min). Same protocol as pass 5 — global 60/40 split, dHash duplicate groups
on one side, every scored photo absent from every prototype and every trained
detector, dev seed 42, confirmation seeds 99/123/2024/7, reserved 60/20/20
seed 314159. The centroid, rival steal and whitened hard margin stay on the
global vector; only the **tag term** changes. Variants (each is a per-tag
detector whose min over the kit's tags becomes the tag term, then
`prod/σ + 1.5·hardW/σ + t·tag/σ` as shipped):


| variant             | detector input                                                | training                                                 |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `G`                 | global vector (pass-5 shipped)                                | logistic, whitened, λ 0.01, 100 Adam steps               |
| `T0max` / `T0mean`  | `G` applied to each tile, pooled                              | none                                                     |
| `T1max`             | tile vectors, max over tiles                                  | MIL logistic from zero; argmax tile takes the gradient   |
| `T1w`               | tile vectors, max at inference                                | MIL warm-started from `G`, top-3 mean pooling, 200 steps |
| `T2max`             | tile vectors, max at inference                                | every tile inherits the photo label (dev seed only)      |
| `M` / `X`           | one 512-d view: L2-normalised mean / per-dim max of the tiles | logistic on that view                                    |
| `M4`                | mean of the 4 corner tiles only                               | logistic                                                 |
| `GM` / `GX` / `GM4` | `[whitened global ; whitened view]` (1024-d)                  | logistic                                                 |
| `*gmax`             | `max(G, tile variant)` per tag                                | —                                                        |
| `hybrid`            | per tag `G` or `T1w`, by training-set AUC                     | —                                                        |
| `dual V +w`         | shipped scorer plus `w·V/σ` as a fourth term                  | —                                                        |


Tile whitening uses the training photos' tiles (66k rows, 9 s scatter + 8 s
whitening in Node); MIL ×9 tags 37 s (`T1`) / 82 s (`T1w`); the 1024-d
concat models 7 s per 9 tags.

**Per-tag detector AUC, development test photos (2,353).** Positives = photos
carrying the tag, negatives = every other test photo.


| tag                          | n    | `G`      | `T0max` | `T1max` | `T1w`    | `T2max` | `M`  | `M4` | `GM`     | `GX` | `GM4` |
| ---------------------------- | ---- | -------- | ------- | ------- | -------- | ------- | ---- | ---- | -------- | ---- | ----- |
| `t_0001` (11%, inconsistent) | 222  | **86.8** | 64.8    | 87.0    | **88.2** | 74.5    | 83.0 | 69.6 | 87.8     | 85.8 | 85.3  |
| `t_0002`                     | 87   | 98.0     | 87.0    | 91.7    | 92.5     | 87.5    | 95.6 | 84.5 | 98.1     | 97.7 | 98.1  |
| `t_0003`                     | 1578 | 95.8     | 83.7    | 96.1    | 95.6     | 90.5    | 91.6 | 71.3 | 95.8     | 95.3 | 95.4  |
| `t_0004`                     | 1952 | 96.4     | 79.4    | 93.9    | 94.0     | 89.1    | 91.5 | 71.8 | 96.2     | 95.6 | 95.9  |
| `t_0005`                     | 399  | 97.5     | 72.5    | 87.5    | 87.9     | 84.8    | 94.0 | 74.1 | 97.6     | 97.4 | 97.2  |
| `t_0006`                     | 652  | 96.2     | 75.3    | 89.2    | 88.6     | 83.8    | 93.0 | 72.7 | 96.3     | 95.7 | 95.8  |
| `t_0007` (62%, tiny)         | 1400 | **91.6** | 75.9    | 84.9    | 85.1     | 81.0    | 86.7 | 79.3 | **92.2** | 91.1 | 91.3  |
| `t_0008`                     | 324  | 95.7     | 83.5    | 92.6    | 92.3     | 87.1    | 90.4 | 69.3 | 96.1     | 95.2 | 95.5  |
| `t_0009`                     | 829  | 93.3     | 85.0    | 94.2    | 94.5     | 88.4    | 89.0 | 70.9 | 94.0     | 92.6 | 93.0  |


Reading:

- **The gates failed.** The inconsistent tag moved 86.8 → 88.2 at best
(gate: low 90s); the tiny tag 91.6 → 92.2 (gate: several points). Per the
pre-registered rule ("still under 90 → not a spatial problem"), tiles are
dead for `t_0001`. For `t_0007` the tile detectors are *worse* than global
by 6–7pp; the evidence the global detector uses for that tag is scene
context the crop throws away, not the object itself.
- `T0` (global detector on tiles) collapses to 65–87: the learned direction
does not transfer to zoomed crops at all — a distribution shift, not a
pooling issue.
- MIL under-fits even the training set (`T1max` train AUC 92.6 vs `G` 95.9
on `t_0007`; all tags lower) despite having strictly more instances to
choose from. Warm start + softer pooling (`T1w`) fits train worse and
generalises fractionally better; the naive instance labelling (`T2`) is
worst, as expected. `hybrid` picked `G` for all 9 tags on every split.
- The only variant at or above `G` on most tags is the **concatenation of
the global vector with the tile mean** (`GM`): 7/9 tags up by +0.1 to
+1.0. The tile mean alone (`M`) is below `G` on every tag, so it is a
complementary view, not a better one. Corner tiles only (`M4`, `GM4`) lose
most of that — the gain needs the full grid.

**Kit level, saved kits (18), confirmation mean of four seeds; paired
per-kit deltas vs the shipped scorer** `G h1.5 t4`**.**


| scorer                         | hard AUC | hard AP  | hard first-screen | Δ hard AUC (CI)          | Δ first-screen (CI)  |
| ------------------------------ | -------- | -------- | ----------------- | ------------------------ | -------------------- |
| production (0.3.119)           | 84.2     | 40.6     | 57.1              | −8.45 (−10.4, −6.5)      | −20.0 (−26.3, −13.7) |
| **shipped pass 5** `G h1.5 t4` | 92.7     | 60.4     | 77.1              | —                        | —                    |
| `GM h1.5 t4`                   | 92.7     | 61.8     | 78.0              | **+0.04 (−0.27, +0.31)** | +0.93 (−0.93, +3.13) |
| `GX h1.5 t4`                   | 92.5     | 60.4     | 77.9              | −0.20 (−0.38, −0.03)     | +0.81 (−2.78, +4.40) |
| `GM4 h1.5 t4`                  | 92.2     | 60.7     | 78.0              | −0.46 (−1.02, −0.08)     | +0.92 (−0.83, +2.64) |
| `T1max h1.5 t4`                | 90.4     | 54.9     | 72.3              | −2.21 (−3.30, −1.06)     | −4.76 (−11.5, +1.2)  |
| `T1w h1.5 t4`                  | 90.0     | 53.9     | 72.8              | −2.65 (−3.70, −1.59)     | −4.28 (−8.80, +0.23) |
| `T1wgmax h1.5 t4`              | 91.5     | 57.9     | 75.8              | −1.15 (−2.20, −0.22)     | −1.26 (−4.39, +1.77) |
| `hybrid h1.5 t4`               | 92.7     | 60.4     | 77.1              | 0 (= shipped)            | 0                    |
| `dual T1w +1`                  | **93.0** | **62.1** | **78.5**          | **+0.39 (+0.14, +0.65)** | +1.39 (−0.46, +3.01) |


All 28 arity ≥2 kits: shipped 92.4 / 64.1 / 80.6 → `GM` 92.5 / 65.3 / 81.5,
`dual T1w +1` 92.8 / 65.8 / 81.8.

Reserved split (test partition, 25 folds; validation picked `dual T1max +2`):


| scorer          | hard AUC | hard AP | first-screen | Δ hard AUC vs shipped (CI) | Δ first-screen (CI)  |
| --------------- | -------- | ------- | ------------ | -------------------------- | -------------------- |
| shipped         | 92.9     | 63.4    | 72.0         | —                          | —                    |
| `dual T1max +2` | 93.5     | 65.3    | 74.8         | +0.68 (+0.29, +1.04)       | +2.81 (−1.79, +6.97) |
| `GM h1.5 t4`    | 93.5     | 63.8    | 71.2         | +0.59 (+0.15, +1.11)       | −0.77 (−5.95, +3.83) |
| `GM4 h1.5 t4`   | 92.9     | 64.4    | 75.4         | 0.00 (−0.34, +0.28)        | +3.40 (+0.60, +6.46) |
| `T1w h1.5 t4`   | 90.7     | 57.8    | 72.1         | −2.19 (−3.31, −1.25)       | +0.12 (−8.81, +7.86) |


Per saved kit on the dev seed (`GM` vs shipped), 15/18 up on hard AUC by
+0.1 to +0.9, three down (−0.4, −0.5, and −4.7 on `k_0002` with 7 test
positives). The kits containing the two weak tags do not move more than the
others — consistent with the per-tag table.

### Verdict

Tiles at 1/3 of the shortest edge, from ≤720 px thumbnails, do **not**
recover small-in-frame tags in MobileCLIP-S2. What they add is a weak,
generic second view: adding a tile term to the shipped scorer is worth
**+0.4–0.7pp hard AUC** (CIs clear of zero on both the confirmation seeds and
the reserved test) and **+1.5–2pp hard AP**; first-screen deltas of +1 to +3pp
never clear zero. Against that:

- **Scan cost 13–18×** the global scan (135 ms/photo measured on a desktop
GPU; the phone runs the global scan at roughly a second per photo).
- The variant with the significant kit-level gain (`dual T1*`) needs **every
tile vector stored** (37 KB/photo, ~1 GB for a 30k library) and MIL
training in the browser (40–80 s in Node for 3.5k photos). Not viable on
the phone. The storage-friendly variant (`GM`: one extra 512-d mean per
photo, a 1024-d logistic per tag) is +0.04pp on the confirmation seeds.

**Do not ship.** The 7pp gap to a perfect hard AUC is not a spatial-pooling
problem at this input resolution. The pilot code (`kit-tile-layout`,
`embed-tiles`, `tileEmbeddings` store, tile scan job, corpus v4 sidecar,
Manage → Developer controls) is dev-only and off the ranking path; remove it
in a housekeeping batch, or keep only the corpus-export sidecar if another
tile experiment is likely.

### Not tested, and why

- **Full-resolution tiles.** Would need the original file (download +
decrypt + decode of a multi-MB JPEG per photo) — not a PWA-on-mobile
workload. Also unclear it would help `t_0007`, whose global detector wins
on context.
- **1/2-scale grid, 2×2 / 3×3 grids.** `GM4` (corner tiles) already shows
the tile-mean gain shrinking with fewer tiles; the remaining candidates sit
between a null result and a +0.5pp result at 4–9× cost.
- **Classic test-time augmentation** (average the global embedding over 2–3
scaled/shifted full-frame crops) might reproduce `GM`'s complementary
view at 3× rather than 18× cost. Untested; the ceiling is `GM`'s +0.04 to
+0.6pp, so it is not worth a rescan on this corpus.
- **A different image model** (larger input, or a detector-style backbone)
is the only route left for the two weak tags — a different project.



### Reproducing pass 6

```powershell
cd mobileapp
$env:NODE_OPTIONS="--max-old-space-size=6144"
npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass6.ts
# PASS6_DEV_ONLY=1 for the 4-minute development-seed run (includes T2)
```

Reads the v4 JSON and the float32 sidecar from Downloads (paths at the top of
the script); prints to stdout only.

## Kit presence — the "kit likeness" percentage list (2026-09-10)

Runner: `scripts/kit-presence-s2.ts` (~~3 min, 5 seeds). Different question
from ranking: given the photos in view, **which kits are present and how
much**. Production (~~`rankKitsByBestFitShareEmbedding`~~) is winner-takes-all:
each embedded photo counts for the one kit whose nearest medoid is closest,
share = wins / scored. Truth here = fraction of the view's photos carrying
all of a kit's tags. Views drawn from the test side of a 60/40 dup-safe
split: whole test set, tag-filtered (9), kit-filtered (~~23), contiguous
60-photo id windows (~39), random 60-photo samples (30). Medoids, thresholds
and detectors from the training side. 24 saved kits (≥20 members; single-tag
kits included, as the app lists them).

Estimators (per photo, per kit → averaged over the view):


| name              | per-photo kit score                                                                                                               | sums to 1 over kits |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| production        | 1 for the nearest-medoid kit                                                                                                      | yes                 |
| softmax τ         | `exp(−d_k/τ) / Σ` over medoid distances                                                                                           | yes                 |
| distance logistic | per kit, 1-D logistic on the medoid distance (natural prior)                                                                      | no                  |
| tag product       | Π over the kit's tags of σ(per-tag logistic log-odds), shipped pass-5 detectors with the class-balance shift `log(n₊/n₋)` removed | no                  |
| tag min           | min instead of product                                                                                                            | no                  |
| kit logistic      | one whitened logistic per kit (members vs rest), natural prior                                                                    | no                  |
| `@0.5`            | any of the above hardened to a count of photos with p ≥ 0.5                                                                       | no                  |


**Prevalence semantics, mean over 5 seeds, all views** (MAE in pp over
kits; "major" = kits truly ≥ 10%; ρ = Spearman of estimated vs true kit
order; top-1 = estimated top kit is within 10% of the true top; top-3 =
recall of the true top three; ghosts = kits truly < 2% shown ≥ 10%, per
view; missed = kits truly ≥ 30% shown < 10%, per view):


| estimator                         | MAE     | major | ρ        | top-1 | top-3 | ghosts   | missed   |
| --------------------------------- | ------- | ----- | -------- | ----- | ----- | -------- | -------- |
| **production (nearest medoid)**   | 12.5    | 30.9  | 0.14     | 31.8  | 34.7  | 0.48     | **1.83** |
| softmax τ=0.02                    | 11.7    | 30.4  | 0.41     | 58.6  | 43.3  | 0.09     | 2.22     |
| softmax τ=0.05                    | 11.8    | 31.2  | 0.46     | 59.4  | 46.6  | 0.00     | 2.99     |
| distance logistic                 | 8.1     | 17.6  | 0.72     | 80.9  | 66.1  | 1.25     | 0.52     |
| tag product (uncorrected)         | 6.1     | 12.9  | 0.82     | 95.9  | 75.7  | 0.78     | 0.06     |
| **tag product (prior-corrected)** | **5.5** | 12.2  | **0.84** | 94.6  | 74.8  | 0.74     | 0.06     |
| tag min (prior-corrected)         | 5.8     | 10.1  | 0.84     | 93.8  | 74.6  | 1.45     | 0.01     |
| tag product (natural prior)       | 5.4     | 12.1  | 0.84     | 95.5  | 75.4  | 0.76     | 0.05     |
| **tag product @0.5 (count)**      | 5.7     | 13.6  | 0.82     | 94.7  | 74.1  | **0.15** | 0.15     |
| kit logistic (natural)            | 5.3     | 10.9  | 0.84     | 94.2  | 75.1  | 0.90     | 0.04     |
| kit logistic @0.5                 | 5.5     | 13.2  | 0.81     | 93.6  | 73.5  | 0.19     | 0.17     |


Worked example, the largest tag-filtered test view (1,952 photos carrying
`t_0004`), kits by true prevalence:


| kit      | tags | truth | production | kit logistic | tag product |
| -------- | ---- | ----- | ---------- | ------------ | ----------- |
| `k_0015` | 2    | 80.8  | **28.9**   | 77.4         | 76.4        |
| `k_0016` | 3    | 46.2  | **11.3**   | 45.1         | 45.5        |
| `k_0020` | 2    | 17.6  | **0.0**    | 13.6         | 15.3        |
| `k_0026` | 3    | 15.8  | **0.0**    | 16.2         | 17.7        |
| `k_0024` | 4    | 13.6  | 7.9        | 14.3         | 13.3        |
| `k_0008` | 3    | 11.9  | **0.0**    | 9.7          | 6.2         |
| `k_0019` | 2    | 11.8  | **0.0**    | 13.7         | 12.5        |
| `k_0001` | 4    | 10.0  | **25.7**   | 10.5         | 7.1         |


Reading:

- **The semantics are the problem, not the softness.** Softmax over
distances (a soft partition) barely moves the numbers and *misses more*
kits (2.2–3.0 per view vs 1.8): any score that sums to 1 over kits has to
split a photo that belongs to `[A,B]` and `[A,B,C]` between them, so
nested kits can never both read high. Under an explicit partition truth
(mass split evenly over a photo's kits) the detector estimators still beat
softmax by a wide margin (ρ 0.77 vs 0.42, top-1 95% vs 58%).
- **Independent per-kit prevalence with the pass-5 per-tag detectors is
accurate**: MAE 5.5pp overall, top kit right 95% of the time, 0.06 missed
kits per view. Product over the kit's tags nests correctly by
construction (a superset kit can never exceed its subset). The per-kit
logistic is equivalent (5.3pp) but needs one model per kit instead of one
per tag.
- **Hardening to a count** (photos with p ≥ 0.5) trades a little MAE on the
big kits (13.6 vs 12.2 major) for five times fewer ghosts (0.15 vs 0.74
per view) — sibling kits sharing 2 of 3 tags otherwise read 10–15% on views
where nothing fits them. It also gives the display a literal meaning ("N of
M photos fit").
- Kit-filtered views are the hardest for every estimator (major MAE ~37pp):
every photo is truly a member, the detectors recall ~65–75% of them. In
the app those views are tag filters, where the tags are *known* — see
below.
- The 1-D distance logistic (medoids + two numbers per kit, no whitening) is
a cheap 8.1pp fallback if one is ever needed; not worth a second code
path today.



### Shipped (`0.3.122`)

The winner-takes-all share is replaced by a **per-kit count**: a file fits
kit `k` when the product over `k`'s tags of its tag probability is ≥ 0.5
(`KIT_PRESENCE_FIT_THRESHOLD`), where a tag the file already carries has
probability 1 and a missing tag uses the shipped per-tag logistic model's
σ(log-odds + log(n₊/n₋)) — files without an embedding only fit through
known tags. The list shows `Kit name (count)` — a count, not a percentage,
since counts are independent per kit and do not sum to the view — sorted by
count, ties to the kit with more tags.

Code: `tagPresenceProbabilities` + `countKitPresence` in
`kit-nearness-margins.ts`; a `presence` request in the margins worker
(same cached whitening and tag models as ranking; the first request trains
one model per kit tag, later ones are a dot product per file); the
`countKitPresenceInWorker` job; `TagFilterBar` posts the shown files on
every view change and the dropdown shows names without a count until the
worker answers. Tags with fewer than 8 positives or negatives in the
training sample are dropped and the kits using them show no count.

Not measured here: the known-tag override (all corpus photos are tagged, so
hiding tags is the only way to test estimation). The table above is the
all-unknown lower bound; tag-filtered views in the app are exact for the
filter tags.

**Dropdown ONLY (`0.3.129`)** — the list now counts exact tag sets, not AND
product: a known extra tag in the kit vocabulary rejects the parent, and
untagged stills use predicted-set equality at θ=0.4. Gallery ranking is
unchanged (AND). See the ONLY-retune section.

### Reproducing pass 5

```powershell
cd mobileapp
npx tsx --tsconfig scripts/tsconfig.json scripts/kit-nearness-s2-pass5.ts
# PASS5_DUP_THRESHOLD=2|10 for stress runs, PASS5_SKIP_LR=1 to skip training
```

The runner prints to stdout only and never writes the corpus or derived
vectors. Families dropped after the first pass-5 run are listed in the script
header; their numbers are in the ablation and dead-end lists above.

## Exact-tag membership vs AND (2026-09-10)

Runner: `scripts/kit-nearness-s2-exact-membership.ts` (~1 min, 5 seeds).
Shipped scorer and splits (centroid λ=16 τ=0.02, whitened hard margin,
per-tag logistic min, h1.5 t4). Membership today is AND: every kit tag,
extras allowed. Exact = the photo's user-tag set *is* the kit's tags.

AND baseline on this run matched the published numbers (ranking hard AUC
92.9 vs 93.0; presence tag-product@0.5 MAE 5.7pp, ρ 0.82, top-1 94.7,
ghosts 0.15).

**How much of a kit is extras** (saved kits, ranking corpus, arity ≥ 2):
high-arity kits are already almost exact (`k_0004` 5 tags, 1.8% extras;
`k_0013`/`k_0004` style). Nested 2–3 tag kits are mostly supersets
(`k_0022` 93.5% extras, `k_0018` 91.3%, `k_0011` 89%). CLIP centroids of
AND vs exact members are nearly the same (cosine Δ 0.000–0.04) — extras
still contain the kit tags, so they look like members.

**Gallery ranking** (saved arity ≥ 2, seed-averaged; Δ vs AND/AND):


| seeds / eval                         | hard AUC | hard AP | first-screen | Δ hard AUC          |
| ------------------------------------ | -------- | ------- | ------------ | ------------------- |
| AND / AND (shipped)                  | 92.9     | 61.0    | 76.1         | —                   |
| exact centroid, extras out of c_hard / AND | 92.6 | 61.0    | 79.2         | **−0.3pp** [−0.6, −0.2] |
| exact centroid, extras in c_hard / AND     | 92.4 | 60.6    | 79.0         | **−0.6pp** [−0.8, −0.4] |
| AND / exact                          | 89.3     | 33.0    | 41.9         | −3.7pp              |
| exact-hard / exact                   | 92.1     | 42.3    | 59.3         | −0.9pp              |


Purer seeds do not help the current (AND) job. Treating extras as the
thing to find is easy because they already sit in the top of the ranking
(median percentile 15% under the shipped scorer). Treating extras as
*negatives* (exact retrieval) cannot work well: they are visually the same
as exact members, so first-screen and hard AP collapse even when AUC is
recovered by stuffing extras into `c_hard`. One kit (`k_0021`) drops
below 20 exact members.

**Kit list order** (tagged counts, no CLIP): Spearman 0.70 on the ranking
corpus (arity ≥ 2), **0.41** on the presence corpus (all 24 saved kits,
single-tag included). AND top-3 on the ranking corpus is
`k_0002` / `k_0001` / `k_0022`; exact top-3 is `k_0002` / `k_0001` /
`k_0008` — nested kits collapse.

**Kit presence estimator** vs exact truth (same views as the presence
section):


| estimator                         | truth | MAE  | ρ    | top-1 | ghosts |
| --------------------------------- | ----- | ---- | ---- | ----- | ------ |
| tag product @0.5 (shipped)        | AND   | 5.7  | 0.82 | 94.7  | 0.15   |
| tag product @0.5 (shipped)        | exact | 8.1  | 0.29 | 66.5  | 3.33   |
| predicted tag-set equals kit @0.5 | exact | 2.2  | 0.64 | 62.3  | 0.23   |


The shipped detector is AND-like by construction (product over the kit's
tags). Pointed at exact prevalence it ghosts nested parents. A hard
predicted-set match calibrates the count (MAE 2.2pp, because exact
prevalence is small) but ranks kits worse than the current AND list.

**Do not ship from that run.** AND-tuned genes on an ONLY task are the
wrong experiment. The follow-up retune is the next section.

## ONLY retune — drowning, presence, ranking GA (2026-09-10)

Runner: `scripts/kit-nearness-s2-only-tune.ts` (~3 min). The previous
exact-membership run reused pass-5 genes. This one searches genes for
ONLY (exact tag-set members; extras = kit tags plus more, treated as hard
negatives) and measures the nested-kit drowning in the kit-likeness
dropdown.

### The drowning is by construction, not a bad λ

The dropdown sorts by fit count, then more tags, then name. Under AND a
parent kit `{A}` counts every photo of child `{A,B}`, so the parent
**always** outranks the child. Presence corpus: **59/59 nested pairs**,
parent AND count ≥ child. Spearman of AND vs ONLY list order is only
0.54.

Worked extras-inflation (AND rank → ONLY rank):

- `k_0019` (2 tags): 1116 AND / 39 exact, rank **3 → 19** (96.5% extras)
- `k_0023` (3): 583 / 22, rank **8 → 23**
- `k_0025` (3): 992 / 64, rank **4 → 17**

Those are the "sky drowns selfie" kits: a tag-set almost always applied
*with more tags* looks huge under AND. High-arity almost-exact kits
rise: `k_0024` 7→3, `k_0001` 9→4, `k_0013` 15→5. Under ONLY, the child
outranks the parent in **23/59** pairs.

This is a count definition, not a CLIP problem. On tagged photos the fix
is `countFilesMatchingKitExact` (already used in tag-picker ONLY mode):
a known extra tag means the photo does not fit.

### Presence estimators vs ONLY truth (5 seeds, app-like views)

`parentWins` = nested parent estimated > child. `child@5` = recall of
arity≥2 kits that are truly in the exact top-5.


| estimator | MAE | ρ | child@5 | parentWins | top-1 |
| --- | --- | --- | --- | --- | --- |
| AND product @0.5 (shipped, soft) | 8.5 | 0.35 | 41.3 | **100** | 66.5 |
| AND product @0.5 hardened | 7.5 | 0.31 | 41.7 | 83.6 | 66.5 |
| **exact-set @0.4** | 2.0 | 0.64 | **83.0** | 38.9 | 56.2 |
| exclusive-hard in0.5 out0.4 | 2.0 | 0.64 | 80.1 | 38.6 | 65.8 |
| kit logistic exact (natural) | 2.6 | 0.65 | 81.2 | 56.3 | **89.3** |
| kit logistic exact @0.5 | 2.2 | 0.61 | 75.6 | **29.0** | 89.7 |

The shipped detector, pointed at ONLY truth, still lets every parent beat
every child. Predicted tag-set equality (or exclusive-hard: kit tags
≥0.5 and other tags <0.4) roughly doubles specific-kit top-5 recall.
Kit-level logistic on exact-vs-rest is the best top-1 but needs one model
per kit.

### Ranking GA / grid (ONLY task)

New terms the AND tuner never had:

- `m_extra = x · S⁻¹(c_exact − c_extras)` (centroid of AND-but-not-exact)
- `m_excl = −max_{t ∉ kit} logodds_t(x)` (penalise extra tags)

Score: `prod/σ + hP·m_partial/σ + hE·m_extra/σ + t·m_tag/σ + x·m_excl/σ`.
Fitness = first-screen mix (0.4 AUC + 0.2 AP + 0.4 hard@12). 648-cell
grid on seed 42, then GA pop 28 × 20 gens × 2 restarts. Confirm on 4
seeds.


| genes | hard AUC | excl AUC | hard AP | first-screen | Δ@12 vs AND-genes |
| --- | --- | --- | --- | --- | --- |
| shipped λ16 τ0.02 h1.5 t4 x0 | 91.3 | 67.7 | 35.5 | 49.1 | — |
| extra-only hE3 | 90.3 | 77.0 | 36.1 | 50.7 | +1.6pp |
| excl-tag x4, rest shipped | 93.1 | 80.0 | 40.2 | 52.4 | +3.2pp |
| **grid** λ8 τ0.06 hP1.5 hE0 t4 x2 | 93.0 | 76.4 | 40.3 | 54.2 | **+5.0pp [3.4, 6.7]** |
| **GA** λ7.5 τ0.07 hP1.5 hE0 t3.6 x1.8 | 93.1 | 76.6 | 40.4 | 54.7 | **+5.5pp [4.2, 6.9]** |

GA ≈ grid. `hE=0` in both winners: stuffing extras into a second centroid
does not beat penalising extra *tags*. Exclusive AUC (exact vs extras
only) 67.7 → 76.6 — CLIP can tell them apart better with the tag term,
but first-screen stays ~55 vs AND's ~76. Thumbnail S2 still cannot put
exact members on screen as reliably as AND members.

Proposed ONLY ranking default, rounded from the grid:

```
useCentroid: 1
rivalLambda: 8
rivalTau: 0.06
hardWeight: 1.5
tagWeight: 4
exclTagWeight: 2   // new: −max extra-tag log-odds / σ
```

### If shipping ONLY

1. **Dropdown / kit list (the drowning bug):** for known tags, a file
fits kit `k` only when its user-tag set *equals* `k`'s tags. That is the
whole fix for tagged photos. Untagged stills: predicted tag-set equals
the kit (θ=0.4) or exclusive-hard; do not keep the AND product.
2. **Gallery ranking:** switch seeds to exact members, `c_hard` =
partial-tag photos (not extras), add `exclTagWeight=2`, drop λ to 8 and
τ to 0.06. Expect first-screen ~55%, not 76.
3. Do not reuse AND genes. Do not bring back a long in-app GA; the 6-gene
grid already matches it.

Not shipped in this session — product choice: AND list is wrong for
nested kits; ONLY ranking is a weaker retrieval task. Owner should decide
whether the dropdown fix is worth the ranking hit.
