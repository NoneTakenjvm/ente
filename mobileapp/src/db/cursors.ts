import { getOrganizerDB } from "./index";

const collectionsUpdationTimeKey = "collections-updation-time";
const trashLastUpdatedAtKey = "trash-last-updated-at";

export const getCollectionSyncTime = async (
    collectionId: number,
): Promise<number | undefined> => {
    const db = await getOrganizerDB();
    const record = await db.get("syncCursors", collectionId);
    return record?.sinceTime;
};

export const saveCollectionSyncTime = async (
    collectionId: number,
    sinceTime: number,
): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("syncCursors", { collectionId, sinceTime });
};

export const removeCollectionSyncTime = async (
    collectionId: number,
): Promise<void> => {
    const db = await getOrganizerDB();
    await db.delete("syncCursors", collectionId);
};

export const getCollectionsUpdationTime = async (): Promise<number | undefined> => {
    const db = await getOrganizerDB();
    return db.get("meta", collectionsUpdationTimeKey);
};

export const saveCollectionsUpdationTime = async (time: number): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("meta", time, collectionsUpdationTimeKey);
};

export const getTrashLastUpdatedAt = async (): Promise<number | undefined> => {
    const db = await getOrganizerDB();
    return db.get("meta", trashLastUpdatedAtKey);
};

export const saveTrashLastUpdatedAt = async (time: number): Promise<void> => {
    const db = await getOrganizerDB();
    await db.put("meta", time, trashLastUpdatedAtKey);
};
