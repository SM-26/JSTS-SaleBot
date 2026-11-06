export interface SweeperJob {
    name: string;
    everyMs: number;
    run: () => Promise<void>;
}

// ponytail: single-process scheduler; atomic claims hold under replicas, move jobs to a leader/queue if we ever run more than one
export function startSweeper(jobs: SweeperJob[]): { stop(): void } {
    const timers = jobs.map(job => {
        let running = false;
        return setInterval(async () => {
            if (running) return; // never overlap itself
            running = true;
            try {
                await job.run();
            } catch (err) {
                console.error(`[ERROR - sweeper:${job.name}]`, err instanceof Error ? err.message : String(err));
            } finally {
                running = false;
            }
        }, job.everyMs);
    });
    return { stop: () => timers.forEach(t => clearInterval(t)) };
}
