import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { EnteCore } from "@/core";

const parseArgs = (): {
    command: string;
    email?: string;
    password?: string;
    totp?: string;
    fileId?: number;
    limit?: number;
    outputDir?: string;
} => {
    const args = process.argv.slice(2);
    const command = args[0] ?? "help";

    const getFlag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i !== -1 ? args[i + 1] : undefined;
    };

    const fileIdRaw = getFlag("--file-id");
    const limitRaw = getFlag("--limit");

    return {
        command,
        email: getFlag("--email") ?? process.env.ENTE_EMAIL,
        password: getFlag("--password") ?? process.env.ENTE_PASSWORD,
        totp: getFlag("--totp") ?? process.env.ENTE_TOTP,
        fileId: fileIdRaw !== undefined ? Number(fileIdRaw) : undefined,
        limit: limitRaw !== undefined ? Number(limitRaw) : undefined,
        outputDir: getFlag("--output"),
    };
};

const promptCredentials = async (): Promise<{
    email: string;
    password: string;
    totp?: string;
}> => {
    const rl = createInterface({ input, output });
    try {
        const email =
            process.env.ENTE_EMAIL ??
            (await rl.question("Email: "));
        const password =
            process.env.ENTE_PASSWORD ??
            (await rl.question("Password: "));
        const totp = process.env.ENTE_TOTP;
        return { email, password, totp };
    } finally {
        rl.close();
    }
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
    return "bin";
};

const ensureLogin = async (
    core: EnteCore,
    creds: ReturnType<typeof parseArgs>,
): Promise<void> => {
    const email = creds.email;
    const password = creds.password;
    if (!email || !password) {
        const prompted = await promptCredentials();
        await core.login(prompted);
        return;
    }
    await core.login({ email, password, totp: creds.totp });
};

const cmdList = async (
    core: EnteCore,
    limit = 20,
): Promise<void> => {
    const collections = await core.listCollections();
    const rows: { id: number; title: string; collection: string }[] = [];

    for (const collection of collections) {
        const files = await core.syncCollectionFiles(collection.id);
        for (const file of files) {
            rows.push({
                id: file.id,
                title: file.metadata.title,
                collection: collection.name,
            });
            if (rows.length >= limit) {
                break;
            }
        }
        if (rows.length >= limit) {
            break;
        }
    }

    if (!rows.length) {
        console.log("No files found.");
        return;
    }

    for (const row of rows) {
        console.log(`${row.id}\t${row.title}\t(${row.collection})`);
    }
};

const cmdDecrypt = async (
    core: EnteCore,
    fileId: number,
    outputDir: string,
): Promise<void> => {
    const file = await core.findFileById(fileId);
    if (!file) {
        throw new Error(`File ${fileId} not found`);
    }

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

    console.log(`Wrote ${thumbPath}`);
    console.log(`Wrote ${fullPath}`);
    console.log(`Wrote ${metadataPath}`);
};

const printHelp = (): void => {
    console.log(`Usage:
  npm run cli -- login [--email E] [--password P] [--totp C]
  npm run cli -- list [--limit N]
  npm run cli -- decrypt --file-id ID [--output DIR]

Environment: ENTE_EMAIL, ENTE_PASSWORD, ENTE_TOTP`);
};

const main = async (): Promise<void> => {
    const args = parseArgs();
    const core = new EnteCore();

    switch (args.command) {
        case "login": {
            await ensureLogin(core, args);
            console.log(`Authenticated as user ${core.getUserID()}`);
            break;
        }
        case "list": {
            await ensureLogin(core, args);
            await cmdList(core, args.limit ?? 20);
            break;
        }
        case "decrypt": {
            if (args.fileId === undefined || !Number.isFinite(args.fileId)) {
                throw new Error("decrypt requires --file-id");
            }
            await ensureLogin(core, args);
            const out =
                args.outputDir ??
                join(process.cwd(), "scripts", "output");
            await cmdDecrypt(core, args.fileId, out);
            break;
        }
        default:
            printHelp();
    }
};

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
