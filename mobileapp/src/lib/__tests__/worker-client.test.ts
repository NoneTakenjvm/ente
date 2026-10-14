import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerClient } from "@/lib/worker-client";

type Message = { id: number; value: number };

class MockWorker {
    static instances: MockWorker[] = [];
    onmessage: ((event: MessageEvent<Message>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    posted: Message[] = [];
    terminated = false;

    constructor() {
        MockWorker.instances.push(this);
    }

    postMessage(message: Message): void {
        this.posted.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }

    reply(message: Message): void {
        this.onmessage?.({ data: message } as MessageEvent<Message>);
    }
}

const makeClient = (
    options: { poolSize?: number; idleMs?: number; timeoutMs?: number } = {},
) =>
    createWorkerClient<Message, Message>({
        createWorker: () => new MockWorker() as unknown as Worker,
        ...options,
    });

beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker);
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("createWorkerClient", () => {
    it("creates the worker lazily and matches replies by id", async () => {
        const client = makeClient();
        expect(MockWorker.instances).toHaveLength(0);

        const first = client.request({ value: 1 });
        const second = client.request({ value: 2 });
        const [worker] = MockWorker.instances;
        expect(MockWorker.instances).toHaveLength(1);
        expect(worker!.posted.map((message) => message.value)).toEqual([1, 2]);

        const [firstId, secondId] = worker!.posted.map((message) => message.id);
        worker!.reply({ id: secondId!, value: 20 });
        worker!.reply({ id: firstId!, value: 10 });
        expect((await first).value).toBe(10);
        expect((await second).value).toBe(20);
    });

    it("spreads requests round-robin over the pool", () => {
        const client = makeClient({ poolSize: 2 });
        void client.request({ value: 1 }).catch(() => undefined);
        void client.request({ value: 2 }).catch(() => undefined);
        void client.request({ value: 3 }).catch(() => undefined);
        expect(MockWorker.instances.map((w) => w.posted.length)).toEqual([2, 1]);
    });

    it("rejects every pending request on worker error and recreates the pool", async () => {
        const client = makeClient({ poolSize: 2 });
        const first = client.request({ value: 1 });
        const second = client.request({ value: 2 });
        MockWorker.instances[0]!.onerror?.({ message: "boom" } as ErrorEvent);

        await expect(first).rejects.toThrow("boom");
        await expect(second).rejects.toThrow("boom");
        expect(MockWorker.instances.every((w) => w.terminated)).toBe(true);

        void client.request({ value: 3 }).catch(() => undefined);
        expect(MockWorker.instances).toHaveLength(4);
    });

    it("rejects pending requests on terminate", async () => {
        const client = makeClient();
        const pending = client.request({ value: 1 });
        client.terminate(new Error("logout"));
        await expect(pending).rejects.toThrow("logout");
    });

    it("terminates the pool and rejects all pending when a request times out", async () => {
        const client = makeClient({ timeoutMs: 1000 });
        const first = client.request({ value: 1 });
        const second = client.request({ value: 2 });
        const failures = Promise.allSettled([first, second]);
        vi.advanceTimersByTime(1000);

        const results = await failures;
        expect(results.map((result) => result.status)).toEqual([
            "rejected",
            "rejected",
        ]);
        expect(MockWorker.instances[0]!.terminated).toBe(true);
    });

    it("does not time out a request that was answered", async () => {
        const client = makeClient({ timeoutMs: 1000 });
        const pending = client.request({ value: 1 });
        const worker = MockWorker.instances[0]!;
        worker.reply({ id: worker.posted[0]!.id, value: 1 });
        await pending;
        vi.advanceTimersByTime(5000);
        expect(worker.terminated).toBe(false);
    });

    it("terminates after the idle delay with nothing in flight", async () => {
        const client = makeClient({ idleMs: 500 });
        const pending = client.request({ value: 1 });
        const worker = MockWorker.instances[0]!;
        vi.advanceTimersByTime(1000);
        expect(worker.terminated).toBe(false);

        worker.reply({ id: worker.posted[0]!.id, value: 1 });
        await pending;
        vi.advanceTimersByTime(500);
        expect(worker.terminated).toBe(true);
    });
});
