# Kit nearness GA — experiment notes

Living log for the offline corpus search. Update after each phase so the next
pass (human or agent) knows what ran and what won.

## CLIP corpus v3 baseline (2026-09-08)

Corpus: `kit-nearness-corpus (1).json` → copied to `kit-nearness-corpus-v3.json`  
photos=4857 withCLIP=4825 kits=6 derivedKits=60 · folds=12 · minCount=50

Export vectors were **not L2-normalized** (pipeline `normalize` ineffective for this
task); eval + `kit-embedding.ts` now force-normalize. Re-export optional.

**Membership task** (holdout exact-set members vs 180 random non-members) — the
real kit-nearness question, not near-dup siblings:

| Method | Pairwise rank (AUC) | Top slots |
|---|---|---|
| dHash prod hybrid | **60%** | **45%** |
| CLIP → 6 medoids | **71%** | **48%** |
| **CLIP → seed centroid** | **77%** | **55%** |

Δ centroid vs dHash: **+17pp AUC**, **+10pp topK**. Still short of ~90% / ~75% feel-good bar.
Within-kit mean cosine ≈ random mean cosine (~0.80) — library is CLIP-compressed;
ranking still separates holdouts (pos mean ~0.79 vs neg ~0.76 on largest kit).

Legacy dHash near-dup protocol (continuity): fitness 0.931 auc=0.723 topK=0.407.

**Next:** bake CLIP centroid into gallery (hybrid with dHash for near-dups), or try
larger CLIP / better thumbs before GA on embedding knobs.

## Next — CLIP corpus v3 (2026-09-08)

dHash ceiling (~73% pairwise / ~43–50% top on ≥50 kits) is the signal limit.
App `0.3.49` exports corpus **v3** with on-device CLIP (`Xenova/clip-vit-base-patch32`,
512-d) for Kit-nearness allowlisted photos. Waiting on user JSON, then:
embedding cosine eval baseline → GA on embeddings → compare to dHash.

## Retune — kits ≥50 members only (2026-09-07)

`--min-count 50` (13 derived kits eligible; 12 folds). Dropped smaller fluff kits.

| | Pairwise rank correct | Near-copies in top slots | Combined fitness |
|---|---|---|---|
| **Current app knobs** | **73%** | **43%** | 0.966 |
| **GA best** | **77%** | **53%** | 1.032 |

GA genome: `colorRadius=3 colorBonus≈1.67 structureGate=18 rivalTau≈5.06 rivalLambda=4 maxMedoids=4 minSeparation=10`

Kits still visually mixed (meanPair ≈ 31–32). Not baked.

## Retune — allowlist corpus (2026-09-07)

GA: pop=96 gens=200 restarts=3 · **40.9s** · 43532 evals

| | Fitness | AUC | topK | excl |
|---|---|---|---|---|
| **Baseline (prod hybrid)** | **0.9449** | 0.723 | 0.414 | 0.790 |
| **GA best** | **0.9748** | 0.735 | 0.498 | 0.765 |
| Δ | **+0.030** | | | |

Best genome:
`colorRadius=2 colorBonus≈2.73 structureGate=19 rivalTau≈2.14 rivalLambda≈3.57 maxMedoids=3 minSeparation=10`

Quick compare (same folds):
- prod hybrid: **0.9449**
- GA best: **0.9748**
- Picsum color + GA medoids/rivals only: **0.9441** (no gain)

→ Almost all of the Δ is from **color** genes, not medoids/rivals. Same Picsum conflict as last retune. Not baked.

Artifact: `.spike-out/kit-nearness-ga-best.json`

## Baseline — allowlist corpus (2026-09-07)

Corpus: `C:/Users/Elliot/Downloads/kit-nearness-corpus.json`  
photos=4857 kits=6 derivedKits=60 · folds=12 (visual near-dup holdouts)

Production hybrid genome:
`colorRadius=8 colorBonus=1.35 structureGate=22 rivalTau=5 rivalLambda=4 maxMedoids=2 minSeparation=10`

| Metric | Value |
|---|---|
| **fitness** | **0.9449** |
| holdout AUC | 0.723 |
| holdout topK | 0.414 |
| excl AUC | 0.790 |
| softRivalLift | 0.000 |

Fold kits still visually incoherent (meanPair ≈ 31.5–32 ≈ random). Same eval question as before: rank near-dup siblings of seeds vs random pool — not thematic kit vibe.

Compare prior (unfiltered) corpus baseline fitness **0.9746** → this allowlist set is a bit harder / different fold mix.

## SHIPPED hybrid bake (2026-09-07)

Picsum validate prefers **color** near gate=22 / bonus=1.35 / radius=8.
Full-GA color (bonus≈3, gate=13) conflicts with that FP-sensitive ranking.

**Hybrid production** (corpus fit ≈1.056, near full GA 1.0576):

| Knob | Value | Source |
|---|---|---|
| colorRadius | 8 | Picsum |
| colorBonus | 1.35 | Picsum |
| structureGate | 22 | Picsum |
| rivalTau | 5 | GA (rounded) |
| rivalLambda | 4 | GA (rounded) |
| maxMedoids | 2 | GA |
| minSeparation | 10 | GA / prior |

`APP_VERSION` → **0.3.44**. Lint + kit-nearness tests + production build green.

Optional next: GA with color genes **locked** to Picsum values.

## Speed work (DONE for iteration)

### Fast scorer (`kit-nearness-corpus-eval-fast.ts`)

- Pack hashes/colors once
- Lazy tables: per (maxMedoids, minSeparation) × fold → per-id per-medoid
  `(structure, color)` arrays; genome apply = float blend
- Bench: **~930 evals/s** (was ~47 → **~20×**)
- GA smoke **96×80×2 = 15.8s** (14948 evals) — same best fit 1.0576
- Full 3×96×200 (~55k evals) should be **~1 min**, not ~20 min

## Corpus

- Path: `C:/Users/Elliot/Downloads/kit-nearness-corpus.json` (v2, private)
- Photos: 4310 tagged; ~4278 with 8-variant dHash + color
- Preset kits: 4
- Derived exact-set kits: 159

## Genes (bounds)

| Gene | Lo | Hi | Default (production hybrid) |
|---|---|---|---|
| colorRadius | 0 | 16 | 8 |
| colorBonus | 0 | 3 | 1.35 |
| structureGate | 8 | 32 | 22 |
| rivalTau | 1 | 24 | 5 |
| rivalLambda | 0 | 4 | 4 |
| maxMedoids | 2 | 8 | 2 |
| minSeparation | 4 | 20 | 10 |

## Fitness

Exact tag kits ≈ random dHash (meanPair~31). Positives = holdouts within
structure ≤14 of seed medoids. Fitness = AUC + 0.25·topK + 0.15·excl − softPenalty.

## Prior runs

- Efficiency smoke: 22.8s / 938 evals → fit 1.0553
- Full GA: **1175s / 55544 evals** → fit **1.0576** (too slow to iterate)
- Artifact: `.spike-out/kit-nearness-ga-best.json`

### Run 2026-09-07T22:03:43.367Z

- Corpus folds: 12; evals=14948; 15.8s; restarts=2
- Baseline fitness: **0.9746** (auc=0.768 topK=0.479 excl=0.578)
- Best fitness: **1.0576** (Δ=0.0829)
- Best genome: `{"colorRadius":7,"colorBonus":2.99858094026086,"structureGate":13,"rivalTau":4.846765224104228,"rivalLambda":3.926570344570478,"maxMedoids":2,"minSeparation":10}`
- Artifact: `.spike-out/kit-nearness-ga-best.json`

### Run 2026-09-07T22:59:30.193Z

- Corpus folds: 12; evals=43532; 40.9s; restarts=3
- Baseline fitness: **0.9449** (auc=0.723 topK=0.414 excl=0.790)
- Best fitness: **0.9748** (Δ=0.0298)
- Best genome: `{"colorRadius":2,"colorBonus":2.726894785851579,"structureGate":19,"rivalTau":2.1364043806679547,"rivalLambda":3.5653532057668427,"maxMedoids":3,"minSeparation":10}`
- Artifact: `.spike-out/kit-nearness-ga-best.json`

### Run 2026-09-07T23:05:24.687Z

- Corpus folds: 12; evals=43822; 44.9s; restarts=3
- Baseline fitness: **0.9664** (auc=0.732 topK=0.430 excl=0.843)
- Best fitness: **1.0323** (Δ=0.0658)
- Best genome: `{"colorRadius":3,"colorBonus":1.674979217230024,"structureGate":18,"rivalTau":5.056857493672332,"rivalLambda":4,"maxMedoids":4,"minSeparation":10}`
- Artifact: `.spike-out/kit-nearness-ga-best.json`

### Majority GA 2026-09-07T23:10:25.062Z

- minCount=50; folds=12; evals=15175; 26.7s
- Medoid prod: pairwise **73%** top **43%**
- Majority default: pairwise **73%** top **51%**
- Majority GA best: pairwise **75%** top **49%**
- Genome: `T=14 y=0.006 λ=2.54 maxSeeds=34`
