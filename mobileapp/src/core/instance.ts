import { EnteCore, type EnteCoreConfig } from "./ente-core";

let instance: EnteCore | undefined;

export const getEnteCore = (config?: EnteCoreConfig): EnteCore => {
    if (!instance) {
        instance = new EnteCore(config);
    }
    return instance;
};

export const resetEnteCore = (): void => {
    instance = undefined;
};
