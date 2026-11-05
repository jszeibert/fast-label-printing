export const MANUAL_VALUES_KEY = 'manual-label-values';

export class ManualLabelValues {
  #storage;
  #values = {};
  #writes = Promise.resolve();

  constructor(storage) {
    this.#storage = storage;
  }

  async load() {
    const stored = await this.#storage.get(MANUAL_VALUES_KEY);
    const values = stored[MANUAL_VALUES_KEY];
    this.#values = values && typeof values === 'object' && !Array.isArray(values)
      ? values
      : {};
  }

  get(jobId) {
    return { ...(this.#values[jobId] ?? {}) };
  }

  save(jobId, values) {
    this.#values[jobId] = { ...values };
    return this.#persist();
  }

  clear(jobId) {
    delete this.#values[jobId];
    return this.#persist();
  }

  #persist() {
    const snapshot = Object.fromEntries(
      Object.entries(this.#values).map(([jobId, values]) => [jobId, { ...values }])
    );
    const write = this.#writes.then(() =>
      this.#storage.set({ [MANUAL_VALUES_KEY]: snapshot })
    );
    this.#writes = write.catch(() => {});
    return write;
  }
}
