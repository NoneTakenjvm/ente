/**
 * Download the public eval datasets (research only) into the model-eval data
 * root and write a `manifest.json` per dataset. Idempotent: archives and
 * extractions already done are skipped.
 *
 * Run from `mobileapp/`:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/model-eval/datasets.ts <dataset|all>
 */
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import {
    modelEvalDataRoot,
    type EvalImage,
    type EvalManifest,
} from "./manifest";

type Dataset = { name: string; run: () => void };

const tarBinary =
    process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";

const datasets: Dataset[] = [
    { name: "coco-val2017", run: prepareCoco },
    { name: "mirflickr25k", run: prepareMirflickr },
    { name: "california-nd", run: prepareCalifornia },
    { name: "copydays", run: prepareCopydays },
    { name: "holidays", run: prepareHolidays },
];

const main = (): void => {
    const target = process.argv[2];
    const selected = datasets.filter(
        (dataset) => target === "all" || dataset.name === target,
    );
    if (!target || selected.length === 0) {
        console.error(
            `Usage: datasets.ts <${datasets.map((d) => d.name).join("|")}|all>`,
        );
        process.exit(1);
    }
    for (const dataset of selected) {
        console.log(`== ${dataset.name}`);
        dataset.run();
    }
};

/** COCO 2017 val images; `labels` are the distinct category names per image. */
function prepareCoco(): void {
    const urls = [
        "http://images.cocodataset.org/zips/val2017.zip",
        "http://images.cocodataset.org/annotations/annotations_trainval2017.zip",
    ];
    const dir = datasetDir("coco-val2017");
    extract(download("val2017.zip", urls[0]!), dir);
    extract(
        download("annotations_trainval2017.zip", urls[1]!),
        dir,
        "annotations/instances_val2017.json",
    );

    const instances = JSON.parse(
        readFileSync(join(dir, "annotations/instances_val2017.json"), "utf8"),
    ) as {
        categories: { id: number; name: string }[];
        annotations: { image_id: number; category_id: number }[];
    };
    const categoryNames = new Map(instances.categories.map((c) => [c.id, c.name]));
    const labelsByImageId = new Map<number, Set<string>>();
    for (const { image_id, category_id } of instances.annotations) {
        const labels = labelsByImageId.get(image_id) ?? new Set<string>();
        labels.add(categoryNames.get(category_id)!);
        labelsByImageId.set(image_id, labels);
    }

    const images = readableImages(dir, "val2017").map((file) => {
        const id = basename(file, extname(file));
        const labels = [...(labelsByImageId.get(Number(id)) ?? [])].sort();
        return { id, file, labels };
    });
    writeManifest(dir, {
        dataset: "coco-val2017",
        source: urls,
        licenseNote:
            "Images: Flickr terms of use, per-image licences (see COCO); annotations CC BY 4.0. https://cocodataset.org/#termsofuse",
        images,
    });
}

/** MIRFLICKR-25000; `labels` are the concepts whose general (non `_r1`) file lists the image. */
function prepareMirflickr(): void {
    const base = "https://press.liacs.nl/mirflickr/mirflickr25k.v3b/";
    const urls = [
        `${base}mirflickr25k.zip`,
        `${base}mirflickr25k_annotations_v080.zip`,
    ];
    const dir = datasetDir("mirflickr25k");
    extract(download("mirflickr25k.zip", urls[0]!), dir);
    extract(
        download("mirflickr25k_annotations_v080.zip", urls[1]!),
        join(dir, "annotations"),
    );

    const labelsById = new Map<string, string[]>();
    for (const file of readdirSync(join(dir, "annotations"))) {
        if (!file.endsWith(".txt") || file.endsWith("_r1.txt") || file === "README.txt") {
            continue;
        }
        const concept = basename(file, ".txt");
        const lines = readFileSync(join(dir, "annotations", file), "utf8").split(/\s+/);
        for (const number of lines.filter(Boolean)) {
            const id = `im${number}`;
            labelsById.set(id, [...(labelsById.get(id) ?? []), concept]);
        }
    }

    const images = readableImages(dir, "", /^im\d+\.jpg$/i).map((file) => {
        const id = basename(file, extname(file));
        return { id, file, labels: (labelsById.get(id) ?? []).sort() };
    });
    writeManifest(dir, {
        dataset: "mirflickr25k",
        source: urls,
        licenseNote:
            "Flickr images under per-image Creative Commons licences (MIRFLICKR terms, https://press.liacs.nl/mirflickr/). Labels come from the general concept files, not the stricter `_r1` relevant ones.",
        images,
    });
}

/**
 * California-ND is skipped: the official zip (https://malea.winkler.site/californiaND.html)
 * is encrypted and the password is only sent to people who email the authors.
 */
function prepareCalifornia(): void {
    console.warn(
        "skipped: californiaND.zip is password protected (password by email from the authors)",
    );
}

/** INRIA Copydays; `group` is the 4-digit block of the original, `edit` the variant. */
function prepareCopydays(): void {
    const base = "https://dl.fbaipublicfiles.com/vissl/datasets/";
    const dir = datasetDir("copydays");
    const images: EvalImage[] = [];
    const source: string[] = [];
    for (const [variant, editOf] of [
        ["original", () => "original"],
        ["strong", () => "strong"],
        ["crop", (parent: string) => `crop-${parent}`],
        ["jpeg", (parent: string) => `jpeg-${parent}`],
    ] as const) {
        const name = `copydays_${variant}.tar.gz`;
        try {
            extract(download(name, base + name), join(dir, variant));
        } catch {
            console.warn(`skipped ${name}: not downloadable from ${base}`);
            continue;
        }
        source.push(base + name);
        for (const file of readableImages(dir, variant)) {
            const parts = file.split("/");
            const id = basename(file, extname(file));
            const edit = editOf(parts[parts.length - 2]!);
            images.push({
                id: variant === "original" ? id : `${variant}/${parts.slice(1).join("/")}`,
                file,
                group: id.slice(0, 4),
                edit,
            });
        }
    }
    writeManifest(dir, {
        dataset: "copydays",
        source,
        licenseNote:
            "INRIA Copydays, free for research use (https://thoth.inrialpes.fr/~jegou/data.php.html#copydays); mirrored by the VISSL project.",
        images,
    });
}

/** INRIA Holidays; images sharing `floor(id / 100)` are one scene. */
function prepareHolidays(): void {
    const base = "ftp://ftp.inrialpes.fr/pub/lear/douze/data/";
    const urls = [`${base}jpg1.tar.gz`, `${base}jpg2.tar.gz`];
    const dir = datasetDir("holidays");
    extract(download("jpg1.tar.gz", urls[0]!), dir);
    extract(download("jpg2.tar.gz", urls[1]!), dir);

    const images = readableImages(dir, "", /^\d+\.jpg$/i).map((file) => {
        const id = basename(file, extname(file));
        return { id, file, group: String(Math.floor(Number(id) / 100)) };
    });
    writeManifest(dir, {
        dataset: "holidays",
        source: urls,
        licenseNote:
            "INRIA Holidays, free for research use (https://thoth.inrialpes.fr/~jegou/data.php.html#holidays).",
        images,
    });
}

/** Folder for a dataset, created on demand. */
function datasetDir(name: string): string {
    const dir = join(modelEvalDataRoot(), name);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Download into `_archives/` (resumable) unless already there; returns the archive path. */
function download(archive: string, url: string): string {
    const path = join(modelEvalDataRoot(), "_archives", archive);
    if (!existsSync(path)) {
        mkdirSync(join(modelEvalDataRoot(), "_archives"), { recursive: true });
        console.log(`downloading ${url}`);
        execFileSync(
            "curl.exe",
            ["-L", "--fail", "-C", "-", "--retry", "5", "-sS", "-o", `${path}.part`, url],
            { stdio: "inherit" },
        );
        renameSync(`${path}.part`, path);
    }
    return path;
}

/** Extract an archive (optionally only `members`) into `dir`, once. */
function extract(archive: string, dir: string, ...members: string[]): void {
    const marker = join(dir, `.extracted-${basename(archive)}-${members.length}`);
    if (existsSync(marker)) {
        return;
    }
    mkdirSync(dir, { recursive: true });
    execFileSync(tarBinary, ["-xf", archive, "-C", dir, ...members], {
        stdio: "inherit",
    });
    writeFileSync(marker, "");
}

/**
 * Non-empty files under `dir/sub` matching `pattern` (on the file name),
 * relative to `dir`, sorted. Zero-byte files are dropped and counted.
 */
function readableImages(dir: string, sub: string, pattern = /\.(jpe?g|png)$/i): string[] {
    const found: string[] = [];
    let dropped = 0;
    const walk = (relative: string): void => {
        for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path);
            } else if (pattern.test(entry.name)) {
                if (statSync(join(dir, path)).size === 0) {
                    dropped++;
                } else {
                    found.push(path);
                }
            }
        }
    };
    walk(sub);
    console.log(`${found.length} images, ${dropped} zero-byte dropped`);
    return found.sort();
}

function writeManifest(dir: string, manifest: EvalManifest): void {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    console.log(`wrote ${manifest.dataset}/manifest.json (${manifest.images.length} images)`);
}

main();
