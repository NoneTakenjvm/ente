import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { EnteCore } from "@/core";
import { FileType } from "ente-media/file-type";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const outputDir = join(scriptDir, "output");

const parseFileId = (): number | undefined => {
    const args = process.argv.slice(2);
    const i = args.indexOf("--file-id");
    if (i === -1) {
        return undefined;
    }
    const raw = args[i + 1];
    const fileID = Number(raw);
    if (!Number.isFinite(fileID)) {
        throw new Error(`Invalid --file-id value: ${raw}`);
    }
    return fileID;
};

const imageExtension = (bytes: Uint8Array): string => {
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "jpg";
    }
    if (
        bytes.length >= 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    ) {
        return "png";
    }
    throw new Error(
        "Decrypted bytes are not a recognized JPEG or PNG (magic bytes check failed)",
    );
};

const main = async (): Promise<void> => {
    const fileID = parseFileId();
    const core = new EnteCore();

    const rl = createInterface({ input, output });
    let email: string;
    let password: string;
    try {
        email =
            process.env.ENTE_EMAIL ?? (await rl.question("Email: "));
        password =
            process.env.ENTE_PASSWORD ?? (await rl.question("Password: "));
    } finally {
        rl.close();
    }

    console.log("M0 crypto spike — login + decrypt one file");
    await core.login({ email, password, totp: process.env.ENTE_TOTP });

    const collections = await core.listCollections();
    let file = fileID !== undefined ? await core.findFileById(fileID) : undefined;

    if (!file) {
        for (const collection of collections) {
            const files = await core.syncCollectionFiles(collection.id);
            file = files.find(
                (f) =>
                    f.metadata.fileType === FileType.image ||
                    f.metadata.fileType === FileType.livePhoto,
            );
            if (file) {
                break;
            }
        }
    }

    if (!file) {
        throw new Error("No image file found");
    }

    console.log(`Selected file ${file.id}: ${file.metadata.title}`);
    console.log(
        `  caption: ${core.getPublicMetadata(file).caption ?? "(none)"}`,
    );

    const thumbBytes = await core.getDecryptedThumbnail(file);
    const fullBytes = await core.getDecryptedFile(file);

    await mkdir(outputDir, { recursive: true });
    const thumbPath = join(
        outputDir,
        `${file.id}-thumb.${imageExtension(thumbBytes)}`,
    );
    const fullPath = join(
        outputDir,
        `${file.id}-full.${imageExtension(fullBytes)}`,
    );
    const metadataPath = join(outputDir, `${file.id}-metadata.json`);

    await writeFile(thumbPath, thumbBytes);
    await writeFile(fullPath, fullBytes);
    await writeFile(
        metadataPath,
        JSON.stringify(
            {
                id: file.id,
                title: file.metadata.title,
                pubMagicMetadata: core.getPublicMetadata(file),
            },
            null,
            2,
        ),
    );

    console.log("\nDone:");
    console.log(`  ${thumbPath}`);
    console.log(`  ${fullPath}`);
    console.log(`  ${metadataPath}`);
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
