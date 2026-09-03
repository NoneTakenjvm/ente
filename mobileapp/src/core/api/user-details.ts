import { z } from "zod";
import type { HttpClient } from "./http";

const nullToUndefined = <T>(value: T | null | undefined): T | undefined =>
    value === null ? undefined : value;

const nullishToZero = (value: number | null | undefined): number =>
    value ?? 0;

const nullishToEmpty = <T>(value: T[] | null | undefined): T[] => value ?? [];

const Subscription = z.object({
    productID: z.string(),
    storage: z.number(),
    expiryTime: z.number(),
    paymentProvider: z.string(),
    price: z.string(),
    period: z
        .string()
        .transform((period) =>
            period === "month" || period === "year" ? period : undefined),
    attributes: z
        .object({
            isCancelled: z
                .boolean()
                .nullish()
                .transform(nullToUndefined),
        })
        .nullish()
        .transform(nullToUndefined),
});

const FamilyMember = z.object({
    email: z.string(),
    isAdmin: z.boolean().nullish().transform(nullToUndefined),
    usage: z.number().nullish().transform(nullToUndefined),
    storageLimit: z.number().nullish().transform(nullToUndefined),
});

const FamilyData = z.object({
    members: z.array(FamilyMember),
    storage: z.number(),
});

const Bonus = z.object({
    type: z.string(),
    storage: z.number(),
    validTill: z.number(),
});

const BonusData = z.object({
    storageBonuses: Bonus.array().nullish().transform(nullishToEmpty),
});

/**
 * Zod schema for {@link UserDetails} from {@code GET /users/details/v2}.
 */
export const UserDetails = z.object({
    email: z.string(),
    usage: z.number(),
    fileCount: z.number().nullish().transform(nullishToZero),
    subscription: Subscription,
    familyData: FamilyData.nullish().transform(nullToUndefined),
    storageBonus: z.number().nullish().transform(nullishToZero),
    bonusData: BonusData.nullish().transform(nullToUndefined),
});

export type UserDetails = z.infer<typeof UserDetails>;
export type Subscription = z.infer<typeof Subscription>;

/**
 * Fetch account usage and subscription details from remote.
 */
export const getUserDetails = async (
    http: HttpClient,
): Promise<UserDetails> =>
    UserDetails.parse(await http.authFetchJSON("/users/details/v2"));

export const isPartOfFamily = (userDetails: UserDetails): boolean =>
    (userDetails.familyData?.members.length ?? 0) > 0;

const familyUsage = (userDetails: UserDetails): number =>
    (userDetails.familyData?.members ?? []).reduce(
        (sum, member) => sum + (member.usage ?? 0),
        0,
    );

/**
 * Bytes used against the plan (individual or family pool).
 */
export const planUsageBytes = (userDetails: UserDetails): number =>
    isPartOfFamily(userDetails) ? familyUsage(userDetails) : userDetails.usage;

/**
 * Plan allowance in bytes before bonuses.
 */
export const planStorageBytes = (userDetails: UserDetails): number =>
    isPartOfFamily(userDetails) ?
        (userDetails.familyData?.storage ?? 0) :
        userDetails.subscription.storage;

/**
 * Total allowance including storage bonus.
 */
export const totalAllowanceBytes = (userDetails: UserDetails): number =>
    planStorageBytes(userDetails) + userDetails.storageBonus;

/**
 * True when usage exceeds plan + bonus.
 */
export const hasExceededStorageQuota = (userDetails: UserDetails): boolean =>
    planUsageBytes(userDetails) > totalAllowanceBytes(userDetails);

/**
 * Format byte counts the way Ente labels storage (binary units as "GB").
 */
export const formatStorageBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "?";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};
